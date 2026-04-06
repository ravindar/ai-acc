#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$OSTYPE" != darwin* ]]; then
  echo "desktop:restart is only supported on macOS." >&2
  exit 1
fi

osascript -e 'quit app "Agent Command Center"' >/dev/null 2>&1 || true
pkill -f 'Agent Command Center.app/Contents/MacOS/acc-desktop' >/dev/null 2>&1 || true
pkill -f 'Agent Command Center.app/Contents/Resources/resources/control-plane/index.cjs' >/dev/null 2>&1 || true
sleep 2
"$ROOT_DIR/scripts/open-acc-macos.sh"
