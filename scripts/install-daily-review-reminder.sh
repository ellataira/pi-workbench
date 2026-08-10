#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_plist="$repo_root/launchd/com.ellataira.pi-daily-memory-review.plist"
target_dir="$HOME/Library/LaunchAgents"
target_plist="$target_dir/com.ellataira.pi-daily-memory-review.plist"
runtime_root="$HOME/.agents/runtime/pi-daily-review"
service="gui/$(id -u)/com.ellataira.pi-daily-memory-review"
node_path=$(command -v node)
temporary_plist=$(mktemp "${TMPDIR:-/tmp}/pi-daily-review.XXXXXX")
trap 'rm -f "$temporary_plist"' EXIT

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

escaped_node=$(escape_sed_replacement "$node_path")
escaped_runtime_root=$(escape_sed_replacement "$runtime_root")
/usr/bin/sed \
  -e "s/__NODE_PATH__/$escaped_node/g" \
  -e "s/__RUNTIME_ROOT__/$escaped_runtime_root/g" \
  "$source_plist" > "$temporary_plist"

/usr/bin/plutil -lint "$temporary_plist"
/bin/mkdir -p "$runtime_root/bin" "$runtime_root/src"
/bin/cp "$repo_root/bin/daily-review-reminder.mjs" "$runtime_root/bin/daily-review-reminder.mjs"
for source in action-inbox.mjs action-inbox-store.mjs daily-review-reminder.mjs maintenance-policy.mjs; do
  /bin/cp "$repo_root/src/$source" "$runtime_root/src/$source"
done
/bin/chmod -R go-rwx "$runtime_root"
/bin/mkdir -p "$target_dir"
/bin/cp "$temporary_plist" "$target_plist"
/bin/chmod 600 "$target_plist"
/bin/launchctl bootout "$service" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$(id -u)" "$target_plist"
