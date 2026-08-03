#!/bin/zsh
set -euo pipefail

print -r -- "$*" >> "$PI_PET_FOCUS_LOG"
