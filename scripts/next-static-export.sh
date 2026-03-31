#!/usr/bin/env sh
# Static export (output: "export") cannot bundle dynamic App Router API routes.
# Temporarily move them aside so `next build` succeeds; restore on exit (including failures).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$ROOT/src/app/api"
STASH_DIR="$ROOT/.build-stash-api-$$"

restore() {
    if [ -d "$STASH_DIR/api" ]; then
        mkdir -p "$(dirname "$API_DIR")"
        mv "$STASH_DIR/api" "$API_DIR"
    fi
    rmdir "$STASH_DIR" 2>/dev/null || true
}
trap restore EXIT INT TERM HUP

mkdir -p "$STASH_DIR"
if [ -d "$API_DIR" ]; then
    mv "$API_DIR" "$STASH_DIR/api"
fi

# distDir is `out` (see next.config.ts). Old `out/dev/types/validator.ts` can still list stashed
# API routes; `tsc` then cannot resolve ../../../src/app/api/... — clear before build.
# Use Node's recursive rm with retries because BSD `rm -rf` occasionally flakes on
# Turbopack cache directories on macOS when metadata files are still settling.
if [ -e "$ROOT/out" ]; then
    chmod -R u+w "$ROOT/out" 2>/dev/null || true
    node -e 'const fs=require("fs"); const path=process.argv[1]; fs.rmSync(path,{recursive:true,force:true,maxRetries:8,retryDelay:150});' "$ROOT/out"
fi

(cd "$ROOT" && pnpm exec next build)
