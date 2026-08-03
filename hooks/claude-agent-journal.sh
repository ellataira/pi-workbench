#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_path=$(command -v node)

exec "$node_path" "$script_dir/../bin/agent-journal.mjs" hook-claude
