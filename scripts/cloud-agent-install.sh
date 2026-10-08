#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap: Node deps + flyctl for Nexus deploys.
# flyctl authenticates non-interactively when FLY_API_TOKEN is set (env secret).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -d node_modules ]]; then
  npm ci
elif [[ ! -d server/node_modules ]]; then
  npm --prefix server ci
fi

if [[ ! -d client/node_modules ]]; then
  npm --prefix client ci
fi

FLY_BIN="${FLYCTL_INSTALL:-$HOME/.fly}/bin"
if [[ ! -x "$FLY_BIN/flyctl" ]]; then
  curl -fsSL https://fly.io/install.sh | sh
fi

# Persist PATH for subsequent shells in this VM.
PROFILE_SNIPPET='export FLYCTL_INSTALL="$HOME/.fly"; export PATH="$HOME/.fly/bin:$PATH"'
for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  if [[ -f "$rc" ]] && ! grep -q 'FLYCTL_INSTALL' "$rc" 2>/dev/null; then
    printf '\n# Fly.io CLI (Cloud Agent)\n%s\n' "$PROFILE_SNIPPET" >> "$rc"
  fi
done

export FLYCTL_INSTALL="${FLYCTL_INSTALL:-$HOME/.fly}"
export PATH="$FLYCTL_INSTALL/bin:$PATH"

if [[ -n "${FLY_API_TOKEN:-}" ]]; then
  if fly auth whoami >/dev/null 2>&1; then
    echo "[cloud-agent-install] flyctl authenticated via FLY_API_TOKEN"
  else
    echo "[cloud-agent-install] FLY_API_TOKEN is set but fly auth whoami failed" >&2
  fi
else
  echo "[cloud-agent-install] flyctl installed; set FLY_API_TOKEN env secret for non-interactive auth"
fi
