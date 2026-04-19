#!/usr/bin/env bash
# Fail if any server/src .js file has a syntax error (catches Fly boot failures before deploy).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server"
find src -name '*.js' -print0 | while IFS= read -r -d '' f; do
  node --check "$f"
done
echo "OK: all server/src/*.js parse"
