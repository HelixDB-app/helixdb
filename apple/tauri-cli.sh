#!/usr/bin/env bash
# Resolve the Tauri CLI from pnpm devDependencies (@tauri-apps/cli).
# Do not use `cargo tauri` unless you have installed `cargo install tauri-cli`.
#
# Usage (after REPO_ROOT is set to the repo root):
#   source "$REPO_ROOT/apple/tauri-cli.sh"
#   "$TAURI_CLI" build --target aarch64-apple-darwin

if [[ -z "${REPO_ROOT:-}" ]]; then
  echo "apple/tauri-cli.sh: REPO_ROOT must be set to the repository root." >&2
  exit 1
fi

TAURI_CLI="$REPO_ROOT/node_modules/.bin/tauri"
if [[ ! -x "$TAURI_CLI" ]]; then
  echo "Error: Tauri CLI not found at:" >&2
  echo "  $TAURI_CLI" >&2
  echo "Install dependencies from the repo root: pnpm install" >&2
  exit 1
fi

export TAURI_CLI
