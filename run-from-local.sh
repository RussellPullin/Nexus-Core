#!/bin/bash
# Run the app from the local copy (outside OneDrive) to avoid ETIMEDOUT errors.
# Usage: bash run-from-local.sh

LOCAL="${1:-$HOME/Projects/nexus-core}"

if [[ ! -d "$LOCAL" ]]; then
  echo "Local project not found at: $LOCAL"
  echo "Run the setup first (from this project folder):"
  echo "  bash setup-local.sh"
  exit 1
fi

if [[ ! -d "$LOCAL/node_modules" ]]; then
  echo "Running npm install in $LOCAL ..."
  (cd "$LOCAL" && npm install)
fi

echo "Starting app from $LOCAL ..."
(cd "$LOCAL" && npm start)
