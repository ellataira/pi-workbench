#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PACKAGE_DIR=${SCRIPT_DIR:h}
SOURCE_DIR="$PACKAGE_DIR/pet-app"
APP_DIR="$PACKAGE_DIR/dist/PiPet.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
PADDINGTON_DIR="${CODEX_HOME:-$HOME/.codex}/pets/paddington"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

xcrun swiftc \
  "$SOURCE_DIR/Sources/PiPet/main.swift" \
  -framework AppKit \
  -framework UserNotifications \
  -O \
  -o "$MACOS_DIR/PiPet"

cp "$SOURCE_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$PADDINGTON_DIR/spritesheet.webp" "$RESOURCES_DIR/spritesheet.webp"
cp "$PADDINGTON_DIR/pet.json" "$RESOURCES_DIR/pet.json"

plutil -lint "$CONTENTS_DIR/Info.plist"
codesign --force --deep --sign - "$APP_DIR"

echo "$APP_DIR"
