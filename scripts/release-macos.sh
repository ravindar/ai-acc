#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET:-universal-apple-darwin}"
ARCH_LABEL="${ARCH_LABEL:-}"
TEMP_KEY_PATH=""

cleanup() {
  if [[ -n "$TEMP_KEY_PATH" && -f "$TEMP_KEY_PATH" ]]; then
    rm -f "$TEMP_KEY_PATH"
  fi
}

trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

detect_signing_identity() {
  if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    return
  fi

  if ! command -v security >/dev/null 2>&1; then
    return
  fi

  local detected
  detected="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"

  if [[ -n "$detected" ]]; then
    export APPLE_SIGNING_IDENTITY="$detected"
    echo "Using detected signing identity: $APPLE_SIGNING_IDENTITY"
  fi
}

prepare_api_key() {
  if [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
    return
  fi

  if [[ -z "${APPLE_API_PRIVATE_KEY:-}" || -z "${APPLE_API_KEY:-}" ]]; then
    return
  fi

  TEMP_KEY_PATH="$(mktemp "${TMPDIR:-/tmp}/tauri-notary-key.XXXXXX")"
  printf '%s' "$APPLE_API_PRIVATE_KEY" > "$TEMP_KEY_PATH"
  export APPLE_API_KEY_PATH="$TEMP_KEY_PATH"
}

check_notarization_credentials() {
  local has_api_key="false"
  local has_apple_id="false"

  if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
    has_api_key="true"
  fi

  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    has_apple_id="true"
  fi

  if [[ "$has_api_key" == "false" && "$has_apple_id" == "false" ]]; then
    echo "Warning: notarization credentials were not detected." >&2
    echo "The build can still complete, but the app will not be notarized." >&2
  fi
}

require_command pnpm
require_command rustup
require_command hdiutil

if [[ "$TARGET" == "universal-apple-darwin" ]]; then
  rustup target add x86_64-apple-darwin >/dev/null
fi

detect_signing_identity
prepare_api_key
check_notarization_credentials

cd "$ROOT_DIR"
TARGET="$TARGET" ARCH_LABEL="$ARCH_LABEL" ./scripts/package-macos-dmg.sh
TARGET="$TARGET" ARCH_LABEL="$ARCH_LABEL" ./scripts/verify-macos-release.sh
