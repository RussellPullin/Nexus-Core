#!/usr/bin/env bash
# Deploy Nexus to Fly with a Git tag (code snapshot) and optional live DB backup.
#
# SAFETY: Deploy always builds from THIS folder. If you open an old duplicate workspace
# and run deploy, you ship whatever commit is checked out there — often stale code.
# This script refuses to deploy when that would clearly deploy behind origin/main.
#
# Environment:
#   FLY_APP_NAME              — default: nexus-core-crm
#   SKIP_FLY_BACKUP=1         — skip SSH SQLite backup before deploy
#   NEXUS_DEPLOY_BRANCH       — branch you must be on (default: main)
#   NEXUS_DEPLOY_REMOTE       — default: origin
#   SKIP_DEPLOY_GIT_CHECKS=1  — bypass all git safety checks (not recommended)
#   ALLOW_UNCOMMITTED_DEPLOY=1 — deploy with a dirty working tree (risky)
#   ALLOW_BEHIND_REMOTE_DEPLOY=1 — deploy when local HEAD is behind origin (dangerous)
#
# Code rollbacks: `fly releases rollback` swaps the app image; SQLite stays on the volume.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

APP="${FLY_APP_NAME:-nexus-core-crm}"
DEPLOY_BRANCH="${NEXUS_DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${NEXUS_DEPLOY_REMOTE:-origin}"

check_allowed_origin() {
  local f="$REPO_ROOT/scripts/deploy-allowed-origin.txt"
  [[ -f "$f" ]] || return 0
  local needle
  needle="$(grep -v '^[[:space:]]*#' "$f" | grep -v '^[[:space:]]*$' | head -1 | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [[ -n "$needle" ]] || return 0
  local url
  url="$(git remote get-url "$DEPLOY_REMOTE" 2>/dev/null || echo "")"
  local urll
  urll="$(echo "$url" | tr '[:upper:]' '[:lower:]')"
  if [[ "$urll" != *"$needle"* ]]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "REFUSING TO DEPLOY: Git remote does not look like this Nexus repo." >&2
    echo "Expected URL to contain: $needle" >&2
    echo "Actual $DEPLOY_REMOTE URL: $url" >&2
    echo "You may be in the wrong folder or a fork. Fix remote or edit scripts/deploy-allowed-origin.txt" >&2
    echo "Override: SKIP_DEPLOY_GIT_CHECKS=1" >&2
    exit 1
  fi
}

run_deploy_git_checks() {
  if [[ "${SKIP_DEPLOY_GIT_CHECKS:-}" == "1" ]]; then
    echo "=== SKIP_DEPLOY_GIT_CHECKS=1 — git safety checks disabled ===" >&2
    return 0
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "REFUSING TO DEPLOY: not a git repository. You cannot tell what you are shipping." >&2
    echo "Override: SKIP_DEPLOY_GIT_CHECKS=1" >&2
    exit 1
  fi

  local git_root
  git_root="$(git rev-parse --show-toplevel)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Nexus deploy — working tree: $REPO_ROOT"
  echo "Git root: $git_root"

  check_allowed_origin

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "$DEPLOY_BRANCH" ]]; then
    echo "REFUSING TO DEPLOY: not on branch '$DEPLOY_BRANCH' (you are on '$branch')." >&2
    echo "Wrong workspace or branch? Checkout the branch you intend to ship." >&2
    echo "Override: NEXUS_DEPLOY_BRANCH=$branch or SKIP_DEPLOY_GIT_CHECKS=1" >&2
    exit 1
  fi

  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    if [[ "${ALLOW_UNCOMMITTED_DEPLOY:-}" != "1" ]]; then
      echo "REFUSING TO DEPLOY: uncommitted changes. Commit or stash so the deploy matches Git history." >&2
      git status -s
      echo "Override: ALLOW_UNCOMMITTED_DEPLOY=1" >&2
      exit 1
    fi
    echo "Warning: ALLOW_UNCOMMITTED_DEPLOY=1 — deploying with a dirty working tree." >&2
  fi

  echo "Fetching $DEPLOY_REMOTE $DEPLOY_BRANCH..."
  if git fetch "$DEPLOY_REMOTE" "$DEPLOY_BRANCH" 2>/dev/null; then
    local remote_ref="$DEPLOY_REMOTE/$DEPLOY_BRANCH"
    if git rev-parse "$remote_ref" >/dev/null 2>&1; then
      local local_h remote_h base
      local_h="$(git rev-parse HEAD)"
      remote_h="$(git rev-parse "$remote_ref")"
      if [[ "$local_h" != "$remote_h" ]]; then
        base="$(git merge-base "$local_h" "$remote_h")"
        if [[ "$base" == "$remote_h" ]]; then
          echo "Note: local branch is ahead of $remote_ref (commits not pushed). Deploy uses files on disk — OK." >&2
        elif [[ "$base" == "$local_h" ]]; then
          if [[ "${ALLOW_BEHIND_REMOTE_DEPLOY:-}" != "1" ]]; then
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
            echo "REFUSING TO DEPLOY: this clone is BEHIND $remote_ref." >&2
            echo "Deploying now would publish OLD code (same as opening a stale workspace)." >&2
            echo "Fix:  cd \"$git_root\" && git pull $DEPLOY_REMOTE $DEPLOY_BRANCH" >&2
            echo "Override (dangerous): ALLOW_BEHIND_REMOTE_DEPLOY=1" >&2
            exit 1
          fi
          echo "Warning: ALLOW_BEHIND_REMOTE_DEPLOY=1 — deploying an older snapshot than $remote_ref." >&2
        else
          echo "REFUSING TO DEPLOY: your branch and $remote_ref have diverged. Merge or rebase first." >&2
          echo "Override: SKIP_DEPLOY_GIT_CHECKS=1 (dangerous)" >&2
          exit 1
        fi
      fi
    fi
  else
    echo "Warning: could not fetch $DEPLOY_REMOTE (offline?). Ahead/behind check skipped." >&2
  fi

  echo "Deploying commit: $(git log -1 --oneline)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

run_deploy_git_checks

if [[ "${SKIP_FLY_BACKUP:-}" != "1" ]]; then
  echo "=== Backing up production SQLite on Fly ($APP) ==="
  # fly ssh -C uses exec (no shell): use env(1) + absolute script path — not "cd …" (cd is not a binary).
  if fly ssh console -a "$APP" -C "env DATABASE_PATH=/data/schedule.db DATA_DIR=/data NODE_ENV=production node /app/server/scripts/backup-sqlite.mjs"; then
    echo "=== Fly volume backup finished ==="
  else
    echo "Warning: Fly SSH backup failed or was skipped (auth, app name, or script missing on running image). Deploy continues. Set SKIP_FLY_BACKUP=1 to silence." >&2
  fi
else
  echo "=== SKIP_FLY_BACKUP=1 — not running remote SQLite backup ==="
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TAG="deploy/nexus-$(date -u +%Y%m%d-%H%M%S)"
  git tag -a "$TAG" -m "Nexus deploy snapshot ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "=== Created git tag: $TAG (push with: git push origin $TAG) ==="
fi

echo "=== fly deploy ==="
fly deploy "$@"
