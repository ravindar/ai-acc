#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Agent Command Center"
TARGET="${TARGET:-universal-apple-darwin}"
ARCH_LABEL="${ARCH_LABEL:-}"

read_json_field() {
  local field="$1"
  node -e "const fs = require('fs'); const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))[process.argv[2]]; if (value == null) process.exit(1); process.stdout.write(String(value));" "$2" "$field"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

assert_contains_arch() {
  local binary_path="$1"
  local expected_arch="$2"
  local archs

  archs="$(lipo -archs "$binary_path" 2>/dev/null || file "$binary_path")"

  if [[ "$archs" != *"$expected_arch"* ]]; then
    echo "Expected $binary_path to contain architecture $expected_arch. Found: $archs" >&2
    exit 1
  fi
}

VERSION="$(read_json_field version "$ROOT_DIR/apps/desktop/src-tauri/tauri.conf.json")"

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

if [[ -z "$TARGET" ]]; then
  BUNDLE_ROOT="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle"
else
  BUNDLE_ROOT="$ROOT_DIR/apps/desktop/src-tauri/target/$TARGET/release/bundle"
fi

APP_BUNDLE="$BUNDLE_ROOT/macos/$APP_NAME.app"
DMG_PATH="$BUNDLE_ROOT/dmg/$APP_NAME"_"$VERSION"_"$ARCH_LABEL".dmg
APP_EXECUTABLE="$(find "$APP_BUNDLE/Contents/MacOS" -maxdepth 1 -type f | head -n 1)"
NODE_RESOURCE="$(find "$APP_BUNDLE/Contents/Resources" -path '*/bin/acc-node' -type f | head -n 1)"

require_command node
require_command file
require_command lipo

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "Missing app bundle: $APP_BUNDLE" >&2
  exit 1
fi

if [[ -z "$APP_EXECUTABLE" || ! -f "$APP_EXECUTABLE" ]]; then
  echo "Missing app executable inside bundle: $APP_BUNDLE/Contents/MacOS" >&2
  exit 1
fi

if [[ -z "$NODE_RESOURCE" || ! -f "$NODE_RESOURCE" ]]; then
  echo "Missing embedded Node runtime: $NODE_RESOURCE" >&2
  exit 1
fi

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Missing DMG artifact: $DMG_PATH" >&2
  exit 1
fi

case "$TARGET" in
  universal-apple-darwin)
    assert_contains_arch "$APP_EXECUTABLE" "arm64"
    assert_contains_arch "$APP_EXECUTABLE" "x86_64"
    assert_contains_arch "$NODE_RESOURCE" "arm64"
    assert_contains_arch "$NODE_RESOURCE" "x86_64"
    ;;
  aarch64-apple-darwin)
    assert_contains_arch "$APP_EXECUTABLE" "arm64"
    assert_contains_arch "$NODE_RESOURCE" "arm64"
    ;;
  x86_64-apple-darwin)
    assert_contains_arch "$APP_EXECUTABLE" "x86_64"
    assert_contains_arch "$NODE_RESOURCE" "x86_64"
    ;;
esac

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  require_command codesign
  require_command spctl
  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
  spctl --assess --type execute --verbose=4 "$APP_BUNDLE"
else
  echo "Skipping signing verification because APPLE_SIGNING_IDENTITY is not set."
fi

if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_ID:-}" ]]; then
  require_command xcrun
  xcrun stapler validate "$APP_BUNDLE"
  xcrun stapler validate "$DMG_PATH"
else
  echo "Skipping notarization validation because Apple notarization credentials are not set."
fi

if [[ "${SKIP_PACKAGED_SMOKE:-0}" != "1" ]]; then
  node "$ROOT_DIR/scripts/smoke-packaged-app.mjs" "$APP_BUNDLE"
else
  echo "Skipping packaged app smoke test because SKIP_PACKAGED_SMOKE=1."
fi

echo "Verified macOS release artifacts at $APP_BUNDLE and $DMG_PATH"
