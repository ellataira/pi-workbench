#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_plist="$repo_root/launchd/com.ellataira.pi-monthly-health.plist"
target_dir="$HOME/Library/LaunchAgents"
target_plist="$target_dir/com.ellataira.pi-monthly-health.plist"
service="gui/$(id -u)/com.ellataira.pi-monthly-health"
node_path=$(command -v node)
temporary_plist=$(mktemp "${TMPDIR:-/tmp}/pi-monthly-health.XXXXXX")
trap 'rm -f "$temporary_plist"' EXIT

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

escaped_node=$(escape_sed_replacement "$node_path")
escaped_repo_root=$(escape_sed_replacement "$repo_root")
/usr/bin/sed \
  -e "s/__NODE_PATH__/$escaped_node/g" \
  -e "s/__REPO_ROOT__/$escaped_repo_root/g" \
  "$source_plist" > "$temporary_plist"

/usr/bin/plutil -lint "$temporary_plist"
/bin/mkdir -p "$target_dir"
/bin/cp "$temporary_plist" "$target_plist"
/bin/chmod 600 "$target_plist"
/bin/launchctl bootout "$service" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$(id -u)" "$target_plist"
