#!/bin/bash
set -euo pipefail

# sandbox.sh - Run commands on a remote crabbox VM with worktree isolation
# Usage: ./scripts/sandbox.sh [command...]
# Default: run this repo's test suite
#
# Each invocation gets its own git worktree for parallel isolation.
# Set TASK_ID to reuse a specific worktree across calls.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_NAME="$(basename "$REPO_ROOT")"
TASK_ID="${TASK_ID:-$(date +%s)-$$}"

# Crabbox config
BOX_CLASS="${CRABBOX_CLASS:-cpx62}"

# GitHub .agents repo for syncing skills/commands
AGENTS_REPO="${AGENTS_REPO:-git@github.com:muqsitnawaz/.agents.git}"

die() { echo "error: $*" >&2; exit 1; }

# Ensure deps
command -v agents >/dev/null || die "agents-cli not installed"
command -v crabbox >/dev/null || die "crabbox not installed"

# Load Hetzner token
eval "$(agents secrets export hetzner.com 2>/dev/null)" || die "Failed to load hetzner.com secrets"
export HCLOUD_TOKEN

# Generate GitHub App token for private repo access
generate_github_token() {
  # Load GitHub App credentials (APP_PRIVATE_KEY is the actual key content)
  eval "$(agents secrets export github.com 2>/dev/null)" || return 1

  [[ -n "${APP_ID:-}" && -n "${APP_PRIVATE_KEY:-}" && -n "${APP_INSTALLATION_ID:-}" ]] || return 1

  # Generate JWT (valid 10 min) - key content passed via env var
  local jwt token
  jwt=$(APP_PRIVATE_KEY="$APP_PRIVATE_KEY" python3 -c "
import jwt, time, os
key = os.environ['APP_PRIVATE_KEY']
print(jwt.encode({'iat': int(time.time())-60, 'exp': int(time.time())+600, 'iss': '$APP_ID'}, key, 'RS256'))
" 2>/dev/null) || return 1

  # Exchange JWT for installation token (valid 1 hour)
  token=$(curl -s -X POST \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/$APP_INSTALLATION_ID/access_tokens" | \
    python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

  [[ -n "$token" ]] && echo "$token"
}

GITHUB_TOKEN=$(generate_github_token || true)

# Load Claude token for running agents on sandbox
eval "$(agents secrets export anthropic.com 2>/dev/null)" || true
CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"

# Find or create a crabbox
get_or_create_box() {
  local box_id
  box_id=$(crabbox list 2>/dev/null | grep -oE 'slug=[^ ]+' | head -1 | cut -d= -f2 || true)

  if [[ -z "$box_id" ]]; then
    echo "No running box found, warming up (~60s)..."
    crabbox warmup --class "$BOX_CLASS" >/dev/null
    sleep 5
    box_id=$(crabbox list | grep -oE 'slug=[^ ]+' | head -1 | cut -d= -f2)
  fi

  echo "$box_id"
}

# Bootstrap script for remote (repo-specific: agents-cli = TypeScript)
bootstrap_remote() {
  cat <<'BOOTSTRAP'
set -euo pipefail

# Bun (for TypeScript projects)
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

# Build tools for native modules (node-pty, etc.)
if ! command -v make &>/dev/null; then
  echo "Installing build-essential..."
  sudo apt-get update -qq && sudo apt-get install -y -qq build-essential unzip
fi

# Git identity for tests
git config --global user.email 2>/dev/null || git config --global user.email "ci@crabbox.local"
git config --global user.name 2>/dev/null || git config --global user.name "Crabbox CI"

# GitHub token for private repos (passed from local via env)
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  echo "GitHub App token configured for private repos"
fi

# agents-cli + coding agents (for running agents in sandbox)
if ! command -v agents &>/dev/null; then
  echo "Installing agents-cli..."
  sudo npm install -g @phnx-labs/agents-cli 2>/dev/null || true
fi
if command -v agents &>/dev/null; then
  # Setup agents-cli if not already configured (agents pull -y is non-interactive)
  if [[ ! -d ~/.agents-system ]]; then
    echo "Setting up agents-cli..."
    agents pull -y 2>/dev/null || true
  fi
  # Install Claude Code if not present
  if ! command -v claude &>/dev/null; then
    echo "Installing Claude Code via agents-cli..."
    agents add claude 2>/dev/null || true
  fi
fi

# Claude Code auth (passed from local via env)
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "Claude Code OAuth token configured"
fi

echo "Bootstrap complete."
BOOTSTRAP
}

main() {
  local box_id cmd worktree_dir

  box_id=$(get_or_create_box)
  [[ -n "$box_id" ]] || die "Failed to get crabbox"

  echo "Using crabbox: $box_id (task: $TASK_ID)"

  # Default command: run tests
  if [[ $# -eq 0 ]]; then
    cmd="bun install && bun test"
  else
    cmd="$*"
  fi

  # Isolated workspace path on remote
  workspace_dir="workspaces/${REPO_NAME}-${TASK_ID}"

  # Sync local repo to remote, then copy to isolated workspace
  # Pass tokens to remote for private repo and Claude access
  crabbox run --id "$box_id" -- bash -c "
export GITHUB_TOKEN='${GITHUB_TOKEN:-}'
export CLAUDE_CODE_OAUTH_TOKEN='${CLAUDE_CODE_OAUTH_TOKEN:-}'
$(bootstrap_remote)

REPO_DIR=\"\$(pwd)\"
WORKSPACE_DIR=\"\$REPO_DIR/../$workspace_dir\"

# Create isolated workspace
if [[ ! -d \"\$WORKSPACE_DIR\" ]]; then
  echo \"Creating workspace: $workspace_dir\"
  mkdir -p \"\$WORKSPACE_DIR\"
fi

# Sync from crabbox's rsync target to isolated workspace
rsync -a --delete --exclude='node_modules' --exclude='.bun' \
  \"\$REPO_DIR/\" \"\$WORKSPACE_DIR/\"

cd \"\$WORKSPACE_DIR\"

# Initialize git for tests that need it
if [[ ! -d .git ]]; then
  git init -q
  git add -A
  git commit -q -m 'initial' 2>/dev/null || true
fi

echo \"Working in: \$(pwd)\"
echo \"--- Running: $cmd ---\"
$cmd
"
}

main "$@"
