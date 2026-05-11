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

# Generate GitHub App token for private repo access.
# Resolves the installation ID dynamically from a target repo so the script
# works regardless of whether the App is installed on a user or an org.
# TOKEN_REPO env var (default: muqsitnawaz/.agents) picks which installation.
generate_github_token() {
  eval "$(agents secrets export github.com 2>/dev/null)" || return 1
  [[ -n "${APP_ID:-}" && -n "${APP_PRIVATE_KEY:-}" ]] || return 1

  local target_repo="${TOKEN_REPO:-muqsitnawaz/.agents}"
  local jwt installation_id token

  jwt=$(APP_PRIVATE_KEY="$APP_PRIVATE_KEY" /usr/bin/python3 -c "
import jwt, time, os
key = os.environ['APP_PRIVATE_KEY']
print(jwt.encode({'iat': int(time.time())-60, 'exp': int(time.time())+600, 'iss': '$APP_ID'}, key, 'RS256'))
" 2>/dev/null) || return 1

  installation_id=$(curl -sf \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${target_repo}/installation" | \
    /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

  [[ -n "$installation_id" ]] || return 1

  token=$(curl -s -X POST \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/${installation_id}/access_tokens" | \
    /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

  [[ -n "$token" ]] && echo "$token"
}

GITHUB_TOKEN=$(generate_github_token || true)
[[ -n "$GITHUB_TOKEN" ]] || echo "warn: failed to generate GitHub App token (private repos won't clone)" >&2

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

# GitHub CLI (gh) — used by agents to open PRs, query issues, etc.
if ! command -v gh &>/dev/null; then
  echo "Installing gh..."
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq gh
fi

# Git identity for tests
git config --global user.email 2>/dev/null || git config --global user.email "ci@crabbox.local"
git config --global user.name 2>/dev/null || git config --global user.name "Crabbox CI"

# GitHub token for private repos (passed from local via env)
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  # Remove ALL stale x-access-token rewrites (each previous run added a new
  # section with the token embedded in the section name — they accumulate
  # and git picks one nondeterministically).
  git config --global --get-regexp '^url\.https://x-access-token:.*@github\.com/\.insteadof$' 2>/dev/null \
    | awk '{print $1}' \
    | sed 's/\.insteadof$//' \
    | sort -u \
    | while read -r section; do
        git config --global --remove-section "$section" 2>/dev/null || true
      done
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  # gh CLI looks at GH_TOKEN/GITHUB_TOKEN — set both so `gh pr create` etc. work
  export GH_TOKEN="$GITHUB_TOKEN"
  echo "GitHub App token configured for private repos"
fi

# agents-cli + coding agents (for running agents in sandbox)
if ! command -v agents &>/dev/null; then
  echo "Installing agents-cli..."
  sudo npm install -g @phnx-labs/agents-cli 2>/dev/null || true
fi
if command -v agents &>/dev/null; then
  # First-time setup: clones ~/.agents-system (public) and provisions ~/.agents
  if [[ ! -d ~/.agents-system ]]; then
    echo "Setting up agents-cli..."
    agents setup 2>&1 | tail -3 || true
  fi
  # Put agents shims on PATH so installed CLIs (claude, codex, etc.) are reachable
  export PATH="$HOME/.agents/.cache/shims:$PATH"
  if ! grep -q '\.agents/\.cache/shims' ~/.bashrc 2>/dev/null; then
    echo 'export PATH="$HOME/.agents/.cache/shims:$PATH"' >> ~/.bashrc
  fi
  # Install Claude Code if not present
  if ! command -v claude &>/dev/null; then
    echo "Installing Claude Code via agents-cli..."
    agents add claude 2>&1 | tail -3 || true
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
