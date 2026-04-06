#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="${ACC_APP_BUNDLE:-$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app}"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/acc-desktop"

if [[ "$OSTYPE" != darwin* ]]; then
  echo "desktop:open is only supported on macOS." >&2
  exit 1
fi

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "Missing app bundle: $APP_BUNDLE" >&2
  exit 1
fi

if [[ ! -x "$APP_BINARY" ]]; then
  echo "Missing app executable: $APP_BINARY" >&2
  exit 1
fi

launch_direct() {
  echo "Launch Services could not open the app bundle; launching the app binary directly." >&2
  nohup "$APP_BINARY" >/tmp/acc-desktop.log 2>&1 &
}

if [[ "${ACC_FORCE_DIRECT_LAUNCH:-0}" == "1" ]]; then
  launch_direct
  exit 0
fi

if open "$APP_BUNDLE"; then
  exit 0
fi

launch_direct
