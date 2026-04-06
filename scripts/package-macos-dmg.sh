#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Agent Command Center"
APP_ID="@acc/desktop"
TARGET="${TARGET:-}"
ARCH_LABEL="${ARCH_LABEL:-}"

read_json_field() {
  local field="$1"
  node -e "const fs = require('fs'); const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))[process.argv[2]]; if (value == null) process.exit(1); process.stdout.write(String(value));" "$2" "$field"
}

VERSION="$(read_json_field version "$ROOT_DIR/apps/desktop/src-tauri/tauri.conf.json")"

if [[ -z "$TARGET" ]]; then
  BUILD_ARGS=(--bundles app)
  BUNDLE_ROOT="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle"
else
  BUILD_ARGS=(--target "$TARGET" --bundles app)
  BUNDLE_ROOT="$ROOT_DIR/apps/desktop/src-tauri/target/$TARGET/release/bundle"
fi

if [[ -z "$ARCH_LABEL" ]]; then
  case "$TARGET" in
    universal-apple-darwin)
      ARCH_LABEL="universal"
      ;;
    aarch64-apple-darwin)
      ARCH_LABEL="aarch64"
      ;;
    x86_64-apple-darwin)
      ARCH_LABEL="x64"
      ;;
    "")
      ARCH_LABEL="$(uname -m | sed 's/arm64/aarch64/; s/x86_64/x64/')"
      ;;
    *)
      ARCH_LABEL="$TARGET"
      ;;
  esac
fi

APP_BUNDLE="$BUNDLE_ROOT/macos/$APP_NAME.app"
DMG_SOURCE_DIR="$BUNDLE_ROOT/macos"
DMG_DIR="$BUNDLE_ROOT/dmg"
DMG_PATH="$DMG_DIR/$APP_NAME"_"$VERSION"_"$ARCH_LABEL".dmg

cd "$ROOT_DIR"

ACC_STANDALONE_TARGET="$TARGET" pnpm --filter "$APP_ID" tauri build "${BUILD_ARGS[@]}"

mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"

hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$DMG_SOURCE_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "Expected app bundle was not created: $APP_BUNDLE" >&2
  exit 1
fi

echo "Created standalone DMG at $DMG_PATH"
