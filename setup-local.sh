#!/bin/bash
# Run this script to copy the project to a local folder (outside OneDrive)
# so npm start works without ETIMEDOUT / missing module errors.
# Usage: bash setup-local.sh   OR   bash setup-local.sh /path/to/destination

set -e
SOURCE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/Projects/nexus-core}"

echo "Copying project from:"
echo "  $SOURCE"
echo "To:"
echo "  $DEST"
echo "(excluding node_modules)"
echo ""

# Ensure destination parent exists (e.g. ~/Projects)
mkdir -p "$(dirname "$DEST")"
mkdir -p "$DEST"

if command -v rsync &>/dev/null; then
  rsync -a --exclude='node_modules' --exclude='client/node_modules' --exclude='server/node_modules' --exclude='.git' \
    "$SOURCE/" "$DEST/" || true
fi
# If rsync failed or didn't run, use cp (then remove node_modules so we get a fresh install)
if [[ ! -f "$DEST/package.json" ]]; then
  echo "Using cp (rsync skipped or failed)..."
  (cd "$SOURCE" && cp -R . "$DEST")
  rm -rf "$DEST/node_modules" "$DEST/client/node_modules" "$DEST/server/node_modules" 2>/dev/null || true
fi

if [[ -f "$SOURCE/.env" ]]; then
  cp "$SOURCE/.env" "$DEST/.env"
  echo "Copied .env"
fi

echo "Running npm install in $DEST ..."
(cd "$DEST" && npm install)

echo ""
echo "Done. To run the app, use ONE of these (copy the whole line):"
echo ""
echo "  bash \"$SOURCE/run-from-local.sh\""
echo ""
echo "  cd $DEST && npm start"
echo ""
echo "Open the project in Cursor from: $DEST"
