/**
 * Shim generation and config symlink management for agent version switching.
 *
 * Shims are small shell scripts placed in ~/.agents/shims/ that resolve the
 * active agent version (project-level or user-default), then exec the real
 * binary. Config isolation is achieved by symlinking ~/.{agent} into the
 * per-version home directory. This module also handles versioned aliases
 * (e.g., claude@2.0.65), PATH setup, conflict detection during migration,
 * and resource diffing between versions.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { confirm, select } from '@inquirer/prompts';
import type { AgentId } from './types.js';
import { getShimsDir, getVersionsDir, getBackupsDir, ensureAgentsDir } from './state.js';
export { getShimsDir };
import { AGENTS } from './agents.js';

/**
 * Files and directories to always skip during conflict detection and migration.
 * These are never user config that should be migrated.
 */
const MIGRATION_IGNORE_LIST = new Set([
  'node_modules',
  '.git',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.DS_Store',
  'Thumbs.db',
]);

/**
 * Check if a file/directory should be ignored during migration.
 */
function shouldIgnore(name: string): boolean {
  if (MIGRATION_IGNORE_LIST.has(name)) return true;
  if (name.endsWith('.backup')) return true;
  return false;
}

/**
 * Strategy for handling file conflicts during config migration.
 */
export type ConflictStrategy = 'keep-dest' | 'overwrite' | 'ask-per-file';

/**
 * Information about conflicts found during config migration.
 */
export interface ConflictInfo {
  agent: AgentId;
  version: string;
  conflicts: string[]; // filenames that exist in both src and dest
}

/**
 * Detect conflicting files between source and destination directories.
 * Returns list of filenames that exist in both locations (excluding symlinks in dest).
 */
function detectConflicts(src: string, dest: string, prefix = ''): string[] {
  const conflicts: string[] = [];

  if (!fs.existsSync(src) || !fs.existsSync(dest)) {
    return conflicts;
  }

  // Skip if dest is a symlink (managed resources)
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      return conflicts;
    }
  } catch {
    /* dest not accessible, no conflicts to report */
    return conflicts;
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // Skip files/directories that should never be migrated
    if (shouldIgnore(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    // Skip if dest entry is a symlink (managed resource)
    try {
      const entryDestStat = fs.lstatSync(destPath);
      if (entryDestStat.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        conflicts.push(...detectConflicts(srcPath, destPath, relativePath));
      } else {
        // File exists in both - it's a conflict
        conflicts.push(relativePath);
      }
    } catch {
      // dest entry doesn't exist, not a conflict
    }
  }

  return conflicts;
}

/**
 * Prompt user for conflict resolution strategy.
 */
async function promptConflictStrategy(
  conflictInfos: ConflictInfo[]
): Promise<ConflictStrategy | null> {
  const totalConflicts = conflictInfos.reduce((sum, info) => sum + info.conflicts.length, 0);

  if (totalConflicts === 0) {
    return null; // No conflicts, no prompt needed
  }

  // Show what has conflicts with clear paths
  console.log('\nFile conflicts detected:');
  for (const info of conflictInfos) {
    const agentConfig = AGENTS[info.agent];
    const configDir = agentConfig.configDir; // e.g., ".opencode"
    console.log(`  ${info.conflicts.length} file(s) conflict between:`);
    console.log(`    ~/${configDir}/ (your config)`);
    console.log(`    ${agentConfig.name}@${info.version} (managed version)`);
  }
  console.log();

  // Build choice labels with agent info for clarity
  const firstInfo = conflictInfos[0];
  const firstAgent = AGENTS[firstInfo.agent];
  const versionLabel = conflictInfos.length === 1
    ? `${firstAgent.name}@${firstInfo.version}`
    : 'version';

  const strategy = await select<ConflictStrategy>({
    message: 'Which files should be kept?',
    choices: [
      {
        value: 'keep-dest' as ConflictStrategy,
        name: `Keep ${versionLabel} files (recommended)`,
      },
      {
        value: 'overwrite' as ConflictStrategy,
        name: conflictInfos.length === 1
          ? `Keep ~/${firstAgent.configDir}/ files`
          : 'Keep my config files',
      },
      {
        value: 'ask-per-file' as ConflictStrategy,
        name: `Decide per file (${totalConflicts} file${totalConflicts === 1 ? '' : 's'})`,
      },
    ],
    default: 'keep-dest',
  });

  return strategy;
}

/**
 * Generate the shim script content for an agent.
 *
 * The shim resolves the version in order:
 * 1. agents.yaml in project root (walk up from $PWD, skip ~/.agents/agents.yaml)
 * 2. ~/.agents/agents.yaml default
 *
 * If version is specified but not installed, auto-installs it.
 *
 * Config isolation is handled via symlinks:
 * ~/.{agent} -> ~/.agents/versions/{agent}/{version}/home/.{agent}/
 */
/**
 * Current shim schema version. Bump whenever `generateShimScript` changes
 * in a way that requires existing on-disk shims to be regenerated (new
 * flags, fixed argument parsing, new hooks, etc.). `isShimCurrent` reads
 * this marker out of existing shims to decide whether to regenerate.
 *
 * History:
 *   v1 — initial shim (implicit, no marker).
 *   v2 — `--version=...` form in sync/refresh-rules calls; refresh-rules
 *        shim hook for non-@-capable agents.
 *   v3 — sync/refresh-rules flag renamed `--version` → `--agent-version`
 *        so it no longer collides with commander's top-level `--version`.
 *   v4 — project version marker changed from `.agents-version` to a
 *        root-level `agents.yaml`; shim now skips ~/.agents/agents.yaml
 *        when walking up for a project marker.
 *   v5 — emit CODEX_HOME for codex shims so the versioned config (permissions,
 *        sandbox_mode, rules/agents-deny.rules) is actually read by the codex
 *        binary instead of $HOME/.codex.
 *   v6 — hard-disable Codex startup update checks in the generated shims.
 *   v7 — rename `agents refresh-memory` invocation to `agents refresh-rules`
 *        and capability flag `memoryImports` → `rulesImports`.
 *   v8 — versions moved from ~/.agents-system/versions to ~/.agents/versions
 *        (two-repo split: system = shipped defaults, user = operational state).
 *   v9 — claude shim exports CLAUDE_CODE_OAUTH_TOKEN from per-version
 *        .oauth_token file on Linux (keychain-less sandbox fallback).
 *   v11 — when no default is set or the configured version is not installed,
 *         interactively propose the latest already-installed version.
 *   v12 — helper calls inside generated shims use the absolute agents-cli
 *         entrypoint instead of PATH-resolved `agents`.
 *   v13 — validate agents.yaml version strings before constructing binary paths.
 *   v14 — derive `configDirName` from `agentConfig.configDir` relative to $HOME
 *         instead of hardcoding `.${agent}`. Backwards-compatible for every
 *         existing agent (their configDir is `~/.{agent}`); enables nested
 *         layouts like Antigravity's `~/.gemini/antigravity-cli/`.
 */
export const SHIM_SCHEMA_VERSION = 14;

/** Internal marker string used to embed the schema version in shim scripts. */
const SHIM_VERSION_MARKER = 'agents-shim-version:';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getAgentsBinForGeneratedShim(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
}

/**
 * Generate the full bash shim script for the given agent. The returned string
 * is written to ~/.agents/shims/{cliCommand} and made executable.
 */
export function generateShimScript(agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const cliCommand = agentConfig.cliCommand;
  // Derive the relative config-dir path from the registry. For most agents
  // this is just `.${agent}` (e.g., `.claude`, `.codex`); for nested layouts
  // like Antigravity (`~/.gemini/antigravity-cli`) it carries the full
  // subpath so per-version HOME symlinks reach the right place.
  const configDirName = path.relative(os.homedir(), agentConfig.configDir);
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
  const managedEnv = agent === 'claude'
    ? `
# Claude stores OAuth credentials in the macOS keychain. Scope them to the
# selected version's config directory so switching versions also switches the
# live Claude account.
export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/${configDirName}"
# On Linux sandboxes (no keychain), fall back to a per-version token file.
# The env var always wins if already set; no-op on macOS.
if [ "\$(uname -s)" = "Linux" ] && [ -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "\$CLAUDE_CONFIG_DIR/.oauth_token" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=\$(cat "\$CLAUDE_CONFIG_DIR/.oauth_token")
  export CLAUDE_CODE_OAUTH_TOKEN
fi
`
    : agent === 'codex'
      ? `
# Codex reads its config (approval_policy, sandbox_mode, MCP servers, rules)
# from CODEX_HOME. Point it at the versioned home so permissions/rules
# written by agents-cli actually take effect.
export CODEX_HOME="$VERSION_DIR/home/${configDirName}"
`
      : agent === 'copilot'
        ? `
# GitHub Copilot CLI honors COPILOT_HOME to relocate its config and state
# (settings.json, mcp-config.json, session-state/, logs/, plugins/). Point
# it at the versioned home so MCP servers, custom agents, and session
# history are isolated per copilot version.
export COPILOT_HOME="$VERSION_DIR/home/${configDirName}"
`
        : agent === 'grok'
          ? `
# Grok Build uses GROK_HOME to isolate its entire configuration tree
# (skills, hooks, plugins, agents, memory, sessions, config.toml, MCP, etc.).
# This gives agents-cli full versioned isolation + resource sync for grok.
export GROK_HOME="$VERSION_DIR/home/.grok"
`
          : '';

  // Agents that don't natively resolve @-imports in their rules file need
  // agents-cli to recompile when the user edits a rule/preset file. The
  // check is fast (sha256 of ~8 small files) and skips the recompile when
  // sources haven't changed.
  const refreshRulesCall = !agentConfig.capabilities.rulesImports
    ? `
# Recompile rules if any rule/preset source has changed since last sync.
# Fast-path check (~10-20ms) when nothing changed; full recompile only on
# actual diff. Non-blocking failure — if the refresh errors, we still launch.
"$AGENTS_BIN" refresh-rules --agent "$AGENT" --agent-version "$VERSION" --quiet 2>/dev/null || true
`
    : '';
  const launchArgs = agent === 'codex' ? ' -c check_for_update_on_startup=false' : '';

  return `#!/bin/bash
# Auto-generated by agents-cli - do not edit
# Shim for ${agentConfig.name}
# ${SHIM_VERSION_MARKER} ${SHIM_SCHEMA_VERSION}

AGENTS_SYSTEM_DIR="$HOME/.agents-system"
AGENTS_USER_DIR="$HOME/.agents"
AGENTS_BIN=${agentsBin}
AGENT="${agent}"
CLI_COMMAND="${cliCommand}"

if [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then
  echo "agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN" >&2
  exit 127
fi

# Find project agents.yaml walking up from cwd (skip $HOME/.agents-system/agents.yaml)
find_project_version() {
  local dir="$PWD"
  local user_agents_yaml="$AGENTS_SYSTEM_DIR/agents.yaml"
  while [ "$dir" != "/" ]; do
    local candidate="$dir/agents.yaml"
    if [ -f "$candidate" ] && [ "$candidate" != "$user_agents_yaml" ]; then
      # Parse agents: section — same shape as resolve_default_version()
      local version
      version=$(awk -v agent="$AGENT" '
        /^agents:/ { in_agents=1; next }
        in_agents && /^[^ ]/ { in_agents=0 }
        in_agents && $0 ~ "^  " agent ":" { gsub(/.*:[[:space:]]*["'"'"']?|["'"'"']?[[:space:]]*$/, ""); print; exit }
      ' "$candidate")
      if [ -n "$version" ]; then
        echo "$version"
        return 0
      fi
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# Resolve version from agents.yaml (user default)
resolve_default_version() {
  local meta="$AGENTS_USER_DIR/agents.yaml"
  if [ -f "$meta" ]; then
    awk -v agent="$AGENT" '
      /^agents:/ { in_agents=1; next }
      in_agents && /^[^ ]/ { in_agents=0 }
      in_agents && $0 ~ "^  " agent ":" { gsub(/.*:[[:space:]]*["'"'"']?|["'"'"']?[[:space:]]*$/, ""); print; exit }
    ' "$meta"
  fi
}

# Find project-scoped .agents directory (stop at agents.yaml or .git)
find_project_agents_dir() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.agents" ]; then
      echo "$dir/.agents"
      return 0
    fi
    if [ -f "$dir/agents.yaml" ] || [ -d "$dir/.git" ] || [ -f "$dir/.git" ]; then
      break
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# Find the latest installed version by numeric component comparison.
# Handles both semver (2.1.138) and date-based (2026.5.7) version strings.
find_latest_installed() {
  local versions_dir="$AGENTS_USER_DIR/.history/versions/$AGENT"
  [ -d "$versions_dir" ] || return
  ls "$versions_dir" 2>/dev/null | awk '
    BEGIN { best="" }
    {
      cur = $0
      n = split(cur, a, /[^0-9]+/)
      m = split(best, b, /[^0-9]+/)
      maxn = (n > m) ? n : m
      winner = cur
      for (i=1; i<=maxn; i++) {
        ai = (i<=n) ? a[i]+0 : 0
        bi = (i<=m) ? b[i]+0 : 0
        if (ai > bi) { winner=cur; break }
        if (ai < bi) { winner=best; break }
      }
      best = winner
    }
    END { print best }
  '
}

# Try project version first, then global default
VERSION=$(find_project_version)
VERSION_SOURCE="project"
if [ -z "$VERSION" ]; then
  VERSION=$(resolve_default_version)
  VERSION_SOURCE="default"
fi

if [ -z "$VERSION" ]; then
  LATEST=$(find_latest_installed)
  if [ -n "$LATEST" ]; then
    echo "agents: no default set for $AGENT — found $AGENT@$LATEST installed" >&2
    if [ -t 2 ]; then
      printf "  Set as default and continue? [Y/n] " >&2
      read -r _ans </dev/tty
      case "$_ans" in
        ""|y|Y)
          "$AGENTS_BIN" use "$AGENT" "$LATEST" >/dev/null 2>&1
          VERSION="$LATEST"
          VERSION_SOURCE="default"
          ;;
        *)
          echo "  Run: agents use $AGENT <version>" >&2
          exit 1
          ;;
      esac
    else
      echo "  Run: agents use $AGENT <version>" >&2
      exit 1
    fi
  else
    echo "agents: no version of $AGENT configured" >&2
    echo "  Run: agents add $AGENT@<version>" >&2
    exit 1
  fi
fi

if [[ ! "$VERSION" =~ ^(latest|[A-Za-z0-9._+-]{1,64})$ || "$VERSION" == *..* ]]; then
  echo "agents: invalid version in agents.yaml for $AGENT: $VERSION. Allowed: latest or [A-Za-z0-9._+-]{1,64}" >&2
  exit 1
fi

VERSION_DIR="$AGENTS_USER_DIR/.history/versions/$AGENT/$VERSION"

# Grok special case: binary lives in ~/.grok/downloads/, not node_modules.
# We still use the agents-cli version dir purely for GROK_HOME isolation.
if [ "$AGENT" = "grok" ]; then
  # Try to find a matching binary for the pinned version in the global grok downloads dir.
  GROK_DOWNLOADS="$HOME/.grok/downloads"
  if [ -d "$GROK_DOWNLOADS" ]; then
    # Prefer a binary whose filename contains the exact version
    BINARY=$(ls "$GROK_DOWNLOADS"/grok-* 2>/dev/null | grep -i "$VERSION" | head -1)
    if [ -z "$BINARY" ]; then
      # Fallback to the "current" grok binary (symlink or latest)
      BINARY=$(ls "$GROK_DOWNLOADS"/grok-* 2>/dev/null | head -1)
    fi
  fi
  if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
    # Last resort: whatever is on PATH (user may have installed grok globally)
    BINARY=$(command -v grok 2>/dev/null || echo "")
  fi
else
  BINARY="$VERSION_DIR/node_modules/.bin/$CLI_COMMAND"
fi

# Auto-install if not present
if [ ! -x "$BINARY" ]; then
  if [ "$VERSION_SOURCE" = "project" ]; then
    echo "agents: $AGENT@$VERSION required by agents.yaml but not installed" >&2

    # Spinner animation
    spin() {
      local pid=$1
      local chars="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
      local i=0
      while kill -0 "$pid" 2>/dev/null; do
        printf "\\r  %s Installing $AGENT@$VERSION..." "\${chars:i++%\${#chars}:1}" >&2
        sleep 0.1
      done
      printf "\\r" >&2
    }

    # Run install in background with spinner
    "$AGENTS_BIN" add "$AGENT@$VERSION" --yes >/dev/null 2>&1 &
    install_pid=$!
    spin $install_pid
    wait $install_pid
    install_status=$?

    if [ $install_status -eq 0 ]; then
      echo "  ✔ Installed $AGENT@$VERSION" >&2
    else
      echo "  ✗ Failed to install $AGENT@$VERSION" >&2
      exit 1
    fi
  else
    LATEST=$(find_latest_installed)
    if [ -n "$LATEST" ] && [ "$LATEST" != "$VERSION" ]; then
      echo "agents: $AGENT@$VERSION not installed — found $AGENT@$LATEST installed" >&2
      if [ -t 2 ]; then
        printf "  Switch default to $AGENT@$LATEST and continue? [Y/n] " >&2
        read -r _ans </dev/tty
        case "$_ans" in
          ""|y|Y)
            "$AGENTS_BIN" use "$AGENT" "$LATEST" >/dev/null 2>&1
            VERSION="$LATEST"
            VERSION_DIR="$AGENTS_USER_DIR/.history/versions/$AGENT/$VERSION"
            BINARY="$VERSION_DIR/node_modules/.bin/$CLI_COMMAND"
            ;;
          *)
            echo "  Run: agents add $AGENT@$VERSION" >&2
            exit 1
            ;;
        esac
      else
        echo "  Run: agents add $AGENT@$VERSION" >&2
        exit 1
      fi
    else
      echo "agents: $AGENT@$VERSION not installed" >&2
      echo "  Run: agents add $AGENT@$VERSION" >&2
      exit 1
    fi
  fi
fi

# Sync project-scoped resources into version home if a project .agents/ is present
PROJECT_AGENTS_DIR=$(find_project_agents_dir)
if [ -n "$PROJECT_AGENTS_DIR" ]; then
  "$AGENTS_BIN" sync --agent "$AGENT" --agent-version "$VERSION" --project-dir "$PROJECT_AGENTS_DIR" --quiet >/dev/null 2>&1
fi
${refreshRulesCall}${managedEnv}

exec "$BINARY"${launchArgs} "$@"
`;
}

/**
 * Create a shim for an agent.
 */
export function createShim(agent: AgentId): string {
  ensureAgentsDir();
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);

  const script = generateShimScript(agent);
  fs.writeFileSync(shimPath, script, { mode: 0o755 });

  return shimPath;
}

/**
 * Remove the shim for an agent.
 */
export function removeShim(agent: AgentId): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);

  if (fs.existsSync(shimPath)) {
    fs.unlinkSync(shimPath);
    return true;
  }

  return false;
}

/**
 * Current versioned-alias schema. Bump whenever `generateVersionedAliasScript`
 * changes in a way that requires existing on-disk aliases to be regenerated.
 *
 * History:
 *   v1 — implicit (no marker); no CLAUDE_CONFIG_DIR export, so direct
 *        `claude@X` invocations leaked into ~/.claude (the default version's
 *        symlinked home) and `agents view` never saw the login.
 *   v2 — emit CLAUDE_CONFIG_DIR for claude aliases so each version has its
 *        own isolated config/OAuth slot; stamp a version marker so stale
 *        aliases can be detected and regenerated.
 *   v3 — emit CODEX_HOME for codex aliases so direct `codex@X` invocations
 *        read the versioned permissions/rules instead of $HOME/.codex.
 *   v4 — direct aliases read binaries and config homes from ~/.agents-system.
 *   v5 — hard-disable Codex startup update checks in versioned aliases.
 *   v6 — versions moved from ~/.agents-system/versions to ~/.agents/versions
 *        (two-repo split: system = shipped defaults, user = operational state).
 */
export const VERSIONED_ALIAS_SCHEMA_VERSION = 7;

/** Internal marker string used to embed the schema version in versioned alias scripts. */
const VERSIONED_ALIAS_VERSION_MARKER = 'agents-versioned-alias-version:';

// The version string is interpolated into a generated bash script and into
// a filename. parseAgentSpec / parseVersion already validates this upstream,
// but generators are also called from internal code paths (e.g., re-emit on
// schema bump), so re-check here. Mirrors VERSION_RE in versions.ts.
const ALIAS_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

function assertSafeVersion(version: string): void {
  if (!ALIAS_VERSION_RE.test(version)) {
    throw new Error(`Refusing to generate shim for unsafe version: ${JSON.stringify(version)}`);
  }
}

/**
 * Generate a versioned alias script that directly execs a specific version.
 * e.g., claude@2.0.65 -> directly runs that version's binary
 */
export function generateVersionedAliasScript(agent: AgentId, version: string): string {
  assertSafeVersion(version);
  const agentConfig = AGENTS[agent];
  // Same derivation as `generateShimScript` so nested layouts (e.g.,
  // Antigravity's `~/.gemini/antigravity-cli`) land in the right place.
  const configDirName = path.relative(os.homedir(), agentConfig.configDir);
  const managedEnv = agent === 'claude'
    ? `
# Claude stores OAuth credentials in the macOS keychain. Scope them to this
# version's config directory so direct aliases also switch the live account.
export CLAUDE_CONFIG_DIR="$HOME/.agents/.history/versions/${agent}/${version}/home/${configDirName}"
`
    : agent === 'codex'
      ? `
# Codex reads its config (approval_policy, sandbox_mode, MCP servers, rules)
# from CODEX_HOME. Point direct aliases at the versioned home so permissions
# and rules written by agents-cli actually take effect.
export CODEX_HOME="$HOME/.agents/.history/versions/${agent}/${version}/home/${configDirName}"
`
      : agent === 'copilot'
        ? `
# Copilot honors COPILOT_HOME to relocate ~/.copilot (settings, mcp-config.json,
# session-state, logs). Point direct aliases at the versioned home so per-
# version MCP and session state are isolated.
export COPILOT_HOME="$HOME/.agents/.history/versions/${agent}/${version}/home/${configDirName}"
`
        : '';
  const launchArgs = agent === 'codex' ? ' -c check_for_update_on_startup=false' : '';

  return `#!/bin/bash
# Auto-generated by agents-cli - do not edit
# ${VERSIONED_ALIAS_VERSION_MARKER} ${VERSIONED_ALIAS_SCHEMA_VERSION}
# Direct alias for ${agentConfig.name}@${version}

BINARY="$HOME/.agents/.history/versions/${agent}/${version}/node_modules/.bin/${agentConfig.cliCommand}"

if [ ! -x "$BINARY" ]; then
  echo "agents: ${agent}@${version} not installed" >&2
  exit 1
fi
${managedEnv}

exec "$BINARY"${launchArgs} "$@"
`;
}

/**
 * Read the schema version of an on-disk versioned alias. Returns null if the
 * alias doesn't exist or is a pre-v2 alias (no marker — treated as stale).
 */
export function readVersionedAliasSchemaVersion(agent: AgentId, version: string): number | null {
  const aliasPath = getVersionedAliasPath(agent, version);
  if (!fs.existsSync(aliasPath)) return null;
  try {
    const content = fs.readFileSync(aliasPath, 'utf8');
    const header = content.split('\n', 10).join('\n');
    const match = header.match(new RegExp(VERSIONED_ALIAS_VERSION_MARKER + '\\s*(\\d+)'));
    if (!match) return null;
    return Number(match[1]);
  } catch {
    return null;
  }
}

/**
 * True if the on-disk versioned alias matches the current schema version.
 */
export function isVersionedAliasCurrent(agent: AgentId, version: string): boolean {
  return readVersionedAliasSchemaVersion(agent, version) === VERSIONED_ALIAS_SCHEMA_VERSION;
}

/**
 * Regenerate a versioned alias if missing or stale. Mirrors ensureShimCurrent
 * for the main shim — callers can surface a one-line notice when something
 * was upgraded.
 */
export function ensureVersionedAliasCurrent(agent: AgentId, version: string): 'created' | 'updated' | 'current' {
  const aliasPath = getVersionedAliasPath(agent, version);
  if (!fs.existsSync(aliasPath)) {
    createVersionedAlias(agent, version);
    return 'created';
  }
  if (!isVersionedAliasCurrent(agent, version)) {
    createVersionedAlias(agent, version);
    return 'updated';
  }
  return 'current';
}

/**
 * Get the filesystem path for a versioned alias script.
 */
export function getVersionedAliasPath(agent: AgentId, version: string): string {
  return path.join(getShimsDir(), `${AGENTS[agent].cliCommand}@${version}`);
}

/**
 * Create a versioned alias for a specific agent version.
 * e.g., claude@2.0.65
 */
export function createVersionedAlias(agent: AgentId, version: string): string {
  assertSafeVersion(version);
  ensureAgentsDir();
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const aliasPath = path.join(shimsDir, `${agentConfig.cliCommand}@${version}`);

  const script = generateVersionedAliasScript(agent, version);
  fs.writeFileSync(aliasPath, script, { mode: 0o755 });

  return aliasPath;
}

/**
 * Remove a versioned alias for a specific agent version.
 */
export function removeVersionedAlias(agent: AgentId, version: string): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const aliasPath = path.join(shimsDir, `${agentConfig.cliCommand}@${version}`);

  if (fs.existsSync(aliasPath)) {
    fs.unlinkSync(aliasPath);
    return true;
  }

  return false;
}

/**
 * Check if a versioned alias exists.
 */
export function versionedAliasExists(agent: AgentId, version: string): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const aliasPath = path.join(shimsDir, `${agentConfig.cliCommand}@${version}`);
  return fs.existsSync(aliasPath);
}

/**
 * Get the path to the agent's config directory in HOME.
 * e.g., ~/.claude for claude, ~/.codex for codex
 */
function getAgentConfigPath(agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  return agentConfig.configDir.replace(os.homedir(), home);
}

/**
 * Get the path to the version's config directory.
 * e.g., ~/.agents/versions/claude/2.0.65/home/.claude/
 */
function getVersionConfigPath(agent: AgentId, version: string): string {
  const agentConfig = AGENTS[agent];
  const versionsDir = getVersionsDir();
  // Carry the agent's full configDir subpath so nested layouts work.
  // e.g., antigravity → `.gemini/antigravity-cli`, claude → `.claude`.
  const configDirName = path.relative(os.homedir(), agentConfig.configDir);
  return path.join(versionsDir, agent, version, 'home', configDirName);
}

/**
 * Detect conflicts that would occur when switching config symlink for an agent/version.
 * This allows collecting conflicts upfront before prompting for a strategy.
 *
 * Returns null if no migration is needed (already symlink or doesn't exist),
 * or ConflictInfo with the list of conflicting files.
 */
function detectMigrationConflicts(agent: AgentId, version: string): ConflictInfo | null {
  const configPath = getAgentConfigPath(agent);
  const versionConfigPath = getVersionConfigPath(agent, version);

  try {
    const stat = fs.lstatSync(configPath);

    if (stat.isSymbolicLink()) {
      // Already a symlink - no migration needed, no conflicts
      return null;
    } else if (stat.isDirectory()) {
      // Real directory exists - would need migration
      // Detect conflicts between user's current config and version home
      const conflicts = detectConflicts(configPath, versionConfigPath);
      return {
        agent,
        version,
        conflicts,
      };
    }
    // Not a directory or symlink - unusual, no conflicts to report
    return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config path doesn't exist - no migration needed
      return null;
    }
    return null;
  }
}

/**
 * Switch the agent's config symlink to point to a specific version.
 * e.g., ~/.claude -> ~/.agents/versions/claude/2.0.65/home/.claude/
 *
 * If a real directory exists at the config path, it will be backed up
 * to ~/.agents/backups/{agent}/{timestamp}/ and replaced with a symlink.
 *
 * @param agent - The agent ID
 * @param version - The version to switch to
 *
 * Returns: { success: boolean, backupPath?: string, error?: string }
 */
export async function switchConfigSymlink(
  agent: AgentId,
  version: string
): Promise<{ success: boolean; backupPath?: string; error?: string }> {
  const configPath = getAgentConfigPath(agent);
  const versionConfigPath = getVersionConfigPath(agent, version);

  // Ensure version config directory exists
  if (!fs.existsSync(versionConfigPath)) {
    fs.mkdirSync(versionConfigPath, { recursive: true });
  }

  try {
    const stat = fs.lstatSync(configPath);

    if (stat.isSymbolicLink()) {
      // Already a symlink - check if it points to the correct target
      const currentTarget = fs.readlinkSync(configPath);
      const resolvedCurrent = path.resolve(path.dirname(configPath), currentTarget);
      const resolvedTarget = path.resolve(versionConfigPath);
      if (resolvedCurrent === resolvedTarget) {
        // Already pointing to correct target, no-op
        return { success: true };
      }
      // openclaw mixes user data (openclaw.json, openclaw.db, per-agent
      // workspaces under ~/.openclaw/{agentId}/, memory/) with the version
      // home — silently swapping the symlink to a fresh version home strips
      // every running agent's config + workspace + memory. Carry the user
      // data forward into the new version home before flipping the symlink
      // (keep-dest preserves anything the new version already shipped).
      // Other agents (Claude, Codex, etc.) keep user data outside the
      // version-home dir, so this is openclaw-only by design.
      if (agent === 'openclaw') {
        try {
          if (fs.existsSync(resolvedCurrent) && fs.statSync(resolvedCurrent).isDirectory()) {
            await copyDirContents(resolvedCurrent, versionConfigPath, 'keep-dest');
          }
        } catch (migrationErr) {
          console.error(
            `Warning: openclaw data migration from ${resolvedCurrent} -> ${versionConfigPath} ` +
              `failed: ${(migrationErr as Error).message}. The previous version's data is intact ` +
              `at the old path; you can copy it manually if needed.`
          );
        }
      }
      // Different target - update it
      fs.unlinkSync(configPath);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(versionConfigPath, configPath);
      return { success: true };
    } else if (stat.isDirectory()) {
      // Real directory exists - backup and replace with symlink
      const timestamp = Date.now();

      // Move to backup location
      const backupsDir = getBackupsDir();
      const agentBackupDir = path.join(backupsDir, agent);
      const finalBackupPath = path.join(agentBackupDir, String(timestamp));
      fs.mkdirSync(agentBackupDir, { recursive: true });
      fs.renameSync(configPath, finalBackupPath);

      // Create symlink (parent already exists since the dir we just moved was here)
      fs.symlinkSync(versionConfigPath, configPath);

      return { success: true, backupPath: finalBackupPath };
    } else {
      return { success: false, error: `${configPath} exists but is not a directory or symlink` };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config path doesn't exist - create symlink.
      // For nested layouts (e.g., ~/.gemini/antigravity-cli) the parent dir
      // may also be missing if the parent agent (Gemini) is not installed.
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(versionConfigPath, configPath);
      return { success: true };
    }
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Switch home-level files (outside the config dir) to per-version symlinks.
 * e.g., ~/.claude.json -> ~/.agents/versions/claude/2.0.65/home/.claude.json
 *
 * Uses atomic rename to avoid data loss if another session is running.
 * On first migration (real file -> symlink), merges global auth into
 * ALL installed versions so they inherit the current account.
 */
export function switchHomeFileSymlinks(
  agent: AgentId,
  version: string
): { switched: string[]; errors: string[] } {
  const agentConfig = AGENTS[agent];
  const homeFiles = agentConfig.homeFiles;
  if (!homeFiles || homeFiles.length === 0) return { switched: [], errors: [] };

  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  const versionsDir = getVersionsDir();
  const switched: string[] = [];
  const errors: string[] = [];

  // For Claude, Claude's binary reads CLAUDE_CONFIG_DIR/.claude.json (INSIDE
  // the per-version .claude dir) — not the home-level file this function
  // manages. Reconcile all installed Claude versions so INSIDE is a symlink
  // to OUTSIDE, making OUTSIDE the single source of truth.
  if (agent === 'claude') {
    const reconcile = ensureAllClaudeInsideSymlinks();
    for (const e of reconcile.errors) errors.push(e);
  }

  for (const fileName of homeFiles) {
    const globalPath = path.join(home, fileName);
    const versionFilePath = path.join(versionsDir, agent, version, 'home', fileName);

    try {
      // Ensure version home dir exists
      const versionFileDir = path.dirname(versionFilePath);
      if (!fs.existsSync(versionFileDir)) {
        fs.mkdirSync(versionFileDir, { recursive: true });
      }

      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(globalPath);
      } catch {
        // File doesn't exist at global path — just create symlink
        if (!fs.existsSync(versionFilePath)) {
          fs.writeFileSync(versionFilePath, '{}');
        }
        fs.symlinkSync(versionFilePath, globalPath);
        switched.push(fileName);
        continue;
      }

      if (stat.isSymbolicLink()) {
        // Already a symlink — retarget atomically
        const currentTarget = fs.readlinkSync(globalPath);
        const resolvedCurrent = path.resolve(path.dirname(globalPath), currentTarget);
        const resolvedTarget = path.resolve(versionFilePath);
        if (resolvedCurrent === resolvedTarget) {
          switched.push(fileName);
          continue; // Already correct
        }
        // Atomic retarget: create temp symlink, rename over existing
        if (!fs.existsSync(versionFilePath)) {
          fs.writeFileSync(versionFilePath, '{}');
        }
        const tmpPath = `${globalPath}.agents-tmp-${process.pid}`;
        fs.symlinkSync(versionFilePath, tmpPath);
        fs.renameSync(tmpPath, globalPath);
        switched.push(fileName);
      } else if (stat.isFile()) {
        // Real file — first-time migration
        // Read the global file content
        let globalContent: Record<string, unknown>;
        try {
          globalContent = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        } catch (err) {
          errors.push(`${fileName}: Could not parse ${globalPath}: ${(err as Error).message}`);
          continue;
        }

        // Merge auth into ALL installed version files for this agent
        const agentVersionsDir = path.join(versionsDir, agent);
        if (fs.existsSync(agentVersionsDir)) {
          for (const ver of fs.readdirSync(agentVersionsDir)) {
            const verFilePath = path.join(agentVersionsDir, ver, 'home', fileName);
            const verFileDir = path.dirname(verFilePath);
            if (!fs.existsSync(verFileDir)) {
              fs.mkdirSync(verFileDir, { recursive: true });
            }
            if (fs.existsSync(verFilePath)) {
              // Merge: version-specific fields + global auth fields
              try {
                const verContent = JSON.parse(fs.readFileSync(verFilePath, 'utf-8'));
                const merged = { ...globalContent, ...verContent };
                // Ensure auth from global always wins
                if (globalContent.oauthAccount) {
                  merged.oauthAccount = globalContent.oauthAccount;
                }
                fs.writeFileSync(verFilePath, JSON.stringify(merged, null, 2));
              } catch {
                // If version file is invalid JSON, overwrite with global
                fs.writeFileSync(verFilePath, JSON.stringify(globalContent, null, 2));
              }
            } else {
              // No version file — copy global wholesale
              fs.writeFileSync(verFilePath, JSON.stringify(globalContent, null, 2));
            }
          }
        }

        // Atomic swap: create temp symlink to target version, rename over real file
        const tmpPath = `${globalPath}.agents-tmp-${process.pid}`;
        fs.symlinkSync(versionFilePath, tmpPath);
        fs.renameSync(tmpPath, globalPath);
        switched.push(fileName);
      }
    } catch (err) {
      errors.push(`${fileName}: ${(err as Error).message}`);
    }
  }

  return { switched, errors };
}

/**
 * Claude reads `.claude.json` at `$CLAUDE_CONFIG_DIR/.claude.json`. Our shim
 * points CLAUDE_CONFIG_DIR at `<ver>/home/.claude`, so Claude's real config
 * file lives at `<ver>/home/.claude/.claude.json` (INSIDE), while
 * `switchHomeFileSymlinks` manages `<ver>/home/.claude.json` (OUTSIDE).
 *
 * To keep both views consistent we make INSIDE a symlink to OUTSIDE. Claude's
 * atomic write (`Uf6`) resolves symlinks before the tmp+rename cycle, so the
 * symlink survives across writes and OUTSIDE remains the single source of
 * truth that agents-cli's home-file machinery already manages.
 *
 * This function idempotently reconciles one version:
 *   - INSIDE missing: create symlink -> `../.claude.json` (create OUTSIDE if needed).
 *   - INSIDE already symlink to OUTSIDE: no-op.
 *   - INSIDE is a real file: it's the authoritative auth state (Claude was
 *     writing to it). Move its content to OUTSIDE (merging with OUTSIDE,
 *     INSIDE wins for `oauthAccount`), then replace INSIDE with the symlink.
 *   - Symlink points elsewhere: replace it.
 */
export function ensureClaudeInsideSymlink(version: string): void {
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, 'claude', version, 'home');
  const outsidePath = path.join(versionHome, '.claude.json');
  const insideDir = path.join(versionHome, '.claude');
  const insidePath = path.join(insideDir, '.claude.json');
  const linkTarget = '../.claude.json'; // relative so version dir can be moved

  if (!fs.existsSync(insideDir)) {
    fs.mkdirSync(insideDir, { recursive: true });
  }

  let insideStat: fs.Stats | null = null;
  try {
    insideStat = fs.lstatSync(insidePath);
  } catch {
    /* INSIDE does not exist */
  }

  if (insideStat?.isSymbolicLink()) {
    const currentTarget = fs.readlinkSync(insidePath);
    if (currentTarget === linkTarget) return;
    // Wrong target — replace.
    if (!fs.existsSync(outsidePath)) fs.writeFileSync(outsidePath, '{}');
    fs.unlinkSync(insidePath);
    fs.symlinkSync(linkTarget, insidePath);
    return;
  }

  if (insideStat?.isFile()) {
    // INSIDE is the authoritative file — Claude has been reading/writing it.
    // Merge INSIDE into OUTSIDE, with INSIDE winning on every field, then
    // replace INSIDE with a symlink.
    let insideContent: Record<string, unknown> = {};
    try {
      insideContent = JSON.parse(fs.readFileSync(insidePath, 'utf-8'));
    } catch {
      /* INSIDE corrupt — treat as empty; OUTSIDE preserved as-is */
    }

    let outsideContent: Record<string, unknown> = {};
    if (fs.existsSync(outsidePath)) {
      try {
        outsideContent = JSON.parse(fs.readFileSync(outsidePath, 'utf-8'));
      } catch {
        /* OUTSIDE corrupt — drop it */
      }
    }

    const merged = { ...outsideContent, ...insideContent };
    fs.writeFileSync(outsidePath, JSON.stringify(merged, null, 2));
    fs.unlinkSync(insidePath);
    fs.symlinkSync(linkTarget, insidePath);
    return;
  }

  // INSIDE missing — ensure OUTSIDE exists, then create symlink.
  if (!fs.existsSync(outsidePath)) fs.writeFileSync(outsidePath, '{}');
  fs.symlinkSync(linkTarget, insidePath);
}

/**
 * Apply `ensureClaudeInsideSymlink` to every installed Claude version.
 * Safe to call repeatedly; per-version calls are idempotent.
 */
function ensureAllClaudeInsideSymlinks(): { migrated: string[]; errors: string[] } {
  const versionsDir = getVersionsDir();
  const claudeVersionsDir = path.join(versionsDir, 'claude');
  const migrated: string[] = [];
  const errors: string[] = [];

  if (!fs.existsSync(claudeVersionsDir)) return { migrated, errors };

  for (const entry of fs.readdirSync(claudeVersionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      ensureClaudeInsideSymlink(entry.name);
      migrated.push(entry.name);
    } catch (err) {
      errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }

  return { migrated, errors };
}

/**
 * Get the current config symlink target version, if any.
 */
export function getConfigSymlinkVersion(agent: AgentId): string | null {
  const configPath = getAgentConfigPath(agent);

  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isSymbolicLink()) {
      return null;
    }

    const target = fs.readlinkSync(configPath);
    // Extract version from path like ~/.agents/versions/claude/2.0.65/home/.claude
    const match = target.match(/versions\/[^/]+\/([^/]+)\/home/);
    return match ? match[1] : null;
  } catch {
    /* config path not accessible or not a symlink */
    return null;
  }
}

/**
 * Context for conflict resolution prompts.
 */
interface CopyContext {
  agent: AgentId;
  version: string;
}

/**
 * Copy directory contents with configurable conflict strategy.
 * Skips when dest is a symlink (managed resources that shouldn't be overwritten).
 *
 * @param src - Source directory
 * @param dest - Destination directory
 * @param strategy - How to handle conflicts: 'keep-dest', 'overwrite', or 'ask-per-file'
 * @param context - Agent/version context for prompts (only used when strategy is 'ask-per-file')
 */
async function copyDirContents(
  src: string,
  dest: string,
  strategy: ConflictStrategy = 'keep-dest',
  context?: CopyContext
): Promise<void> {
  // If dest is a symlink, skip - these are managed resources (skills, commands, etc.)
  // that link to central ~/.agents/ and shouldn't be overwritten with local copies
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      return; // Skip - don't copy into symlinked directories
    }
  } catch {
    // dest doesn't exist, that's fine
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // Skip files/directories that should never be migrated
    if (shouldIgnore(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip if dest entry is a symlink (managed resource)
    try {
      const entryDestStat = fs.lstatSync(destPath);
      if (entryDestStat.isSymbolicLink()) {
        continue; // Skip - managed resource
      }
    } catch {
      // dest entry doesn't exist, that's fine
    }

    if (entry.isDirectory()) {
      await copyDirContents(srcPath, destPath, strategy, context);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(srcPath);
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.symlinkSync(linkTarget, destPath);
    } else {
      // File - check for conflict
      if (fs.existsSync(destPath)) {
        // Handle based on strategy
        if (strategy === 'keep-dest') {
          // Keep existing file, skip copying
          continue;
        } else if (strategy === 'overwrite') {
          // Back up and overwrite
          fs.copyFileSync(destPath, `${destPath}.backup`);
        } else if (strategy === 'ask-per-file') {
          // Back up dest file
          fs.copyFileSync(destPath, `${destPath}.backup`);

          // Ask user with context - use clear path-based terminology
          const agentConfig = context ? AGENTS[context.agent] : null;
          const versionLabel = agentConfig
            ? `${agentConfig.name}@${context!.version}`
            : 'version';
          const useMyFile = await confirm({
            message: `${entry.name}: Use your config file instead of ${versionLabel}?`,
            default: false, // Default to keep version (safer)
          });

          if (!useMyFile) {
            continue; // Keep dest (version file), skip copying src
          }
        }
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Check if shim exists for an agent.
 */
export function shimExists(agent: AgentId): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);
  return fs.existsSync(shimPath);
}

/**
 * Read the schema version embedded in an existing on-disk shim. Returns
 * `null` if the shim doesn't exist or has no version marker (pre-v2 shim).
 */
function readShimSchemaVersion(agent: AgentId): number | null {
  if (!shimExists(agent)) return null;
  try {
    const content = fs.readFileSync(getShimPath(agent), 'utf8');
    // Look at the first ~10 lines only — the marker lives in the header.
    const header = content.split('\n', 10).join('\n');
    const match = header.match(new RegExp(SHIM_VERSION_MARKER + '\\s*(\\d+)'));
    if (!match) return null;
    return Number(match[1]);
  } catch {
    return null;
  }
}

/**
 * True if the on-disk shim's schema version matches `SHIM_SCHEMA_VERSION`.
 * False means either the shim is missing, is pre-v2 (no marker), or is an
 * older version that needs regeneration.
 */
function isShimCurrent(agent: AgentId): boolean {
  const version = readShimSchemaVersion(agent);
  return version === SHIM_SCHEMA_VERSION;
}

/**
 * Regenerate the shim if it's missing or outdated. Returns a status describing
 * what happened — callers can surface a one-line notice to the user ("Updated
 * shim for codex") when appropriate.
 */
export function ensureShimCurrent(agent: AgentId): 'created' | 'updated' | 'current' {
  if (!shimExists(agent)) {
    createShim(agent);
    return 'created';
  }
  if (!isShimCurrent(agent)) {
    createShim(agent);
    return 'updated';
  }
  return 'current';
}

/**
 * Get the path to the shim for an agent.
 */
export function getShimPath(agent: AgentId): string {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  return path.join(shimsDir, agentConfig.cliCommand);
}

/**
 * Return the first executable path that would be launched for this agent when
 * resolving against PATH, excluding the managed shim itself.
 *
 * Legacy ~/.agents/shims/<cli> (from the pre-split single-root layout) is NOT
 * treated as a shadow when a current managed shim exists at getShimPath() —
 * that file is dead weight from the old layout and the repair flow removes it
 * separately. Treating it as "shadowing" caused an infinite repair-prompt
 * loop because addShimsToPath() only edits the rc file, never the legacy
 * shim file itself.
 */
export function getPathShadowingExecutable(agent: AgentId): string | null {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shimPath = path.resolve(getShimPath(agent));
  const cliCommand = AGENTS[agent].cliCommand;
  const legacyUserShim = path.resolve(path.join(os.homedir(), '.agents', 'shims', cliCommand));
  const managedShimExists = fs.existsSync(shimPath);

  for (const dir of pathDirs) {
    const candidate = path.resolve(dir, cliCommand);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    if (candidate === shimPath) return null;
    if (candidate === legacyUserShim && managedShimExists) {
      // Legacy file from the pre-split layout. Don't treat as shadow — the
      // repair flow deletes it via removeLegacyUserShim instead. Continue
      // scanning so a real binary later in PATH is still detected.
      continue;
    }
    return candidate;
  }

  return null;
}

/**
 * Delete the legacy ~/.agents/shims/<cli> file if it exists, returning whether
 * anything was removed. Pre-split installs put shims under ~/.agents/shims/;
 * the new layout uses ~/.agents-system/shims/. The leftover file causes the
 * repair-prompt loop reported in PROJ-789 — `getPathShadowingExecutable` flags
 * it as a shadow but `addShimsToPath` only edits rc files, never the file
 * itself. Removing it ends the loop.
 */
export function removeLegacyUserShim(agent: AgentId, overrides?: { homeDir?: string }): boolean {
  const cliCommand = AGENTS[agent].cliCommand;
  const homeDir = overrides?.homeDir || os.homedir();
  const legacyPath = path.join(homeDir, '.agents', 'shims', cliCommand);
  if (!fs.existsSync(legacyPath)) return false;
  // Belt-and-suspenders: only remove if the current managed shim location is
  // different (it always should be — getShimsDir() returns the system dir —
  // but guard against future refactors that might collapse the two).
  const currentShim = path.resolve(getShimPath(agent));
  if (path.resolve(legacyPath) === currentShim) return false;
  try {
    fs.unlinkSync(legacyPath);
    // Best-effort: clean up the legacy shims dir if empty.
    try {
      const legacyDir = path.dirname(legacyPath);
      if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
    } catch { /* best-effort */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the agent's CLI command is shadowed by a shell alias.
 *
 * Shell aliases live in the user's session and aren't visible from a Node.js
 * child process. We do a best-effort scan of common RC files for `alias
 * <command>=` patterns. Returns false when detection is inconclusive.
 */
export function hasAliasShadowingShim(agent: AgentId): boolean {
  const cliCommand = AGENTS[agent].cliCommand;
  const HOME = os.homedir();
  const rcFiles = [
    path.join(HOME, '.zshrc'),
    path.join(HOME, '.bashrc'),
    path.join(HOME, '.bash_profile'),
    path.join(HOME, '.profile'),
  ];

  const pattern = new RegExp(`^\\s*alias\\s+${cliCommand}\\s*=`, 'm');

  for (const rcFile of rcFiles) {
    try {
      if (!fs.existsSync(rcFile)) continue;
      const content = fs.readFileSync(rcFile, 'utf-8');
      if (pattern.test(content)) return true;
    } catch {
      // unreadable rc file — skip
    }
  }
  return false;
}

/**
 * Check if shims directory is in PATH.
 */
export function isShimsInPath(): boolean {
  const shimsDir = getShimsDir();
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  return pathDirs.some((dir) => path.resolve(dir) === path.resolve(shimsDir));
}

function isShimPathCommandLine(line: string, shimsDir: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) {
    return false;
  }

  const normalized = trimmed.replace(/['"]/g, '');
  const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactMarkers = [
    shimsDir,
    '$HOME/.agents-system/shims',
    '${HOME}/.agents-system/shims',
    '~/.agents-system/shims',
    '$HOME/.agents/shims',
    '${HOME}/.agents/shims',
    '~/.agents/shims',
  ];

  const markerRegexes = exactMarkers.map((marker) => new RegExp(`${escapeRegex(marker)}(?=$|[:\\s])`));
  const suffixRegexes = [
    /\/\.agents-system\/shims(?=$|[:\s])/,
    /\/\.agents\/shims(?=$|[:\s])/,
  ];

  const touchesShimPath = [...markerRegexes, ...suffixRegexes].some((pattern) => pattern.test(normalized));
  if (!touchesShimPath) {
    return false;
  }

  return trimmed.startsWith('export PATH=') || trimmed.startsWith('fish_add_path ');
}

function stripShimPathLines(content: string, shimsDir: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.trim() === '# agents-cli: version-managed agent CLIs' &&
      i + 1 < lines.length &&
      isShimPathCommandLine(lines[i + 1], shimsDir)
    ) {
      i++;
      continue;
    }
    if (isShimPathCommandLine(line, shimsDir)) {
      continue;
    }
    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Get the shell rc file path for the current shell.
 */
function getShellRcFile(overrides?: { homeDir?: string; shell?: string }): { rcFile: string; rcPath: string; shell: string } {
  const shell = overrides?.shell || process.env.SHELL || '/bin/bash';
  const shellName = path.basename(shell);

  let rcFile: string;
  switch (shellName) {
    case 'zsh':
      rcFile = '.zshrc';
      break;
    case 'fish':
      rcFile = '.config/fish/config.fish';
      break;
    case 'bash':
    default:
      rcFile = '.bashrc';
      break;
  }

  return {
    rcFile,
    rcPath: path.join(overrides?.homeDir || os.homedir(), rcFile),
    shell: shellName,
  };
}

/**
 * Get shell configuration instructions for adding shims to PATH.
 */
export function getPathSetupInstructions(): string {
  const shimsDir = getShimsDir();
  const { rcFile, shell } = getShellRcFile();

  if (shell === 'fish') {
    return `Add to ~/.config/fish/config.fish:
  fish_add_path ${shimsDir}`;
  }

  return `Add to ~/${rcFile} (AFTER any nvm/node setup):
  export PATH="${shimsDir}:$PATH"

IMPORTANT: Shims must come FIRST in PATH to override global installs.

Then restart your shell or run:
  source ~/${rcFile}`;
}

/**
 * Add shims directory to shell PATH configuration.
 * Returns true if added, false if already present or failed.
 */
export function addShimsToPath(
  overrides?: { homeDir?: string; shell?: string; shimsDir?: string },
): { success: boolean; alreadyPresent?: boolean; rcFile?: string; error?: string } {
  const shimsDir = overrides?.shimsDir || getShimsDir();
  const { rcFile, rcPath, shell } = getShellRcFile(overrides);

  // Read current rc file content
  let content = '';
  try {
    if (fs.existsSync(rcPath)) {
      content = fs.readFileSync(rcPath, 'utf-8');
    }
  } catch (err) {
    return { success: false, error: `Could not read ${rcFile}: ${(err as Error).message}` };
  }

  // Generate the canonical PATH block.
  let exportBlock: string;
  if (shell === 'fish') {
    exportBlock = `# agents-cli: version-managed agent CLIs\nfish_add_path ${shimsDir}\n`;
  } else {
    exportBlock = `# agents-cli: version-managed agent CLIs\nexport PATH="${shimsDir}:$PATH"\n`;
  }

  const contentWithoutShimLines = stripShimPathLines(content, shimsDir);

  // Find insertion point - AFTER node/nvm/fnm setup if present, otherwise append.
  const insertAfterPatterns = [
    /^export NVM_DIR=/m,
    /^source.*nvm/m,
    /^\[ -s.*nvm/m,
    /^eval.*fnm/m,
    /^export PATH.*node/m,
    /^export PATH.*npm/m,
  ];

  let insertIndex = -1;
  const lines = contentWithoutShimLines.split('\n');
  let offset = 0;
  for (const line of lines) {
    const lineWithNewline = `${line}\n`;
    if (insertAfterPatterns.some((pattern) => pattern.test(line))) {
      insertIndex = offset + lineWithNewline.length;
    }
    offset += lineWithNewline.length;
  }

  // Write the updated content
  try {
    // Ensure parent directories exist (especially for fish: ~/.config/fish/)
    const rcDir = path.dirname(rcPath);
    if (!fs.existsSync(rcDir)) {
      fs.mkdirSync(rcDir, { recursive: true });
    }

    let newContent: string;
    if (insertIndex >= 0) {
      // Insert after the last node/nvm/fnm-related line so our prepend wins.
      const before = contentWithoutShimLines.slice(0, insertIndex);
      const separator = before.length > 0 && !before.endsWith('\n\n') ? '\n' : '';
      newContent = before + separator + exportBlock + contentWithoutShimLines.slice(insertIndex);
    } else {
      // Append to end
      const separator = contentWithoutShimLines.length > 0 && !contentWithoutShimLines.endsWith('\n') ? '\n' : '';
      newContent = contentWithoutShimLines + separator + exportBlock;
    }

    newContent = newContent.replace(/\n{2,}$/g, '\n');

    if (newContent === content) {
      return { success: true, alreadyPresent: true, rcFile };
    }

    fs.writeFileSync(rcPath, newContent, 'utf-8');
    return { success: true, rcFile };
  } catch (err) {
    return { success: false, error: `Could not write ${rcFile}: ${(err as Error).message}` };
  }
}

export function listAgentsWithInstalledVersions(): AgentId[] {
  const versionsDir = getVersionsDir();
  if (!fs.existsSync(versionsDir)) {
    return [];
  }

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && AGENTS[entry.name as AgentId])
    .map((entry) => entry.name as AgentId)
    .filter((agent) => fs.readdirSync(path.join(versionsDir, agent), { withFileTypes: true }).some((entry) => entry.isDirectory()));
}

/**
 * Create shims for all installed agents.
 */
function ensureAllShims(): void {
  const versionsDir = getVersionsDir();
  if (!fs.existsSync(versionsDir)) {
    return;
  }

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && AGENTS[entry.name as AgentId]) {
      const agent = entry.name as AgentId;
      const agentVersionsDir = path.join(versionsDir, agent);
      const versions = fs.readdirSync(agentVersionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());

      if (versions.length > 0 && !shimExists(agent)) {
        createShim(agent);
      }
    }
  }
}

/**
 * Resource diff between two versions. Each field lists resources present in
 * the current version but missing from the target.
 */
export interface ResourceDiff {
  commands: string[];  // names in current but not in target
  skills: string[];
  hooks: string[];
  memory: { file: string; currentLines: number; targetLines: number }[];
  mcp: string[];  // server names in current but not in target
}

/**
 * Compare resources between two versions.
 * Returns resources that exist in currentVersion but not in targetVersion.
 */
function compareVersionResources(
  agent: AgentId,
  currentVersion: string,
  targetVersion: string
): ResourceDiff {
  const agentConfig = AGENTS[agent];
  const currentPath = getVersionConfigPath(agent, currentVersion);
  const targetPath = getVersionConfigPath(agent, targetVersion);

  const diff: ResourceDiff = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
  };

  // Helper to list directory contents (names only)
  const listDir = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    } catch {
      /* directory not readable */
      return [];
    }
  };

  // Helper to count lines in a file
  const countLines = (filePath: string): number => {
    if (!fs.existsSync(filePath)) return 0;
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n').length;
    } catch {
      /* file not readable */
      return 0;
    }
  };

  // Compare commands
  const currentCommands = listDir(path.join(currentPath, agentConfig.commandsSubdir));
  const targetCommands = new Set(listDir(path.join(targetPath, agentConfig.commandsSubdir)));
  diff.commands = currentCommands.filter(c => !targetCommands.has(c)).map(c => c.replace(/\.(md|toml)$/, ''));

  // Compare skills
  const currentSkills = listDir(path.join(currentPath, 'skills'));
  const targetSkills = new Set(listDir(path.join(targetPath, 'skills')));
  diff.skills = currentSkills.filter(s => !targetSkills.has(s));

  // Compare hooks
  const currentHooks = listDir(path.join(currentPath, 'hooks'));
  const targetHooks = new Set(listDir(path.join(targetPath, 'hooks')));
  diff.hooks = currentHooks.filter(h => !targetHooks.has(h));

  // Compare memory files (instructionsFile like CLAUDE.md)
  const memoryFile = agentConfig.instructionsFile;
  const currentMemoryPath = path.join(currentPath, memoryFile);
  const targetMemoryPath = path.join(targetPath, memoryFile);
  const currentLines = countLines(currentMemoryPath);
  const targetLines = countLines(targetMemoryPath);
  if (currentLines > 0 && currentLines !== targetLines) {
    diff.memory.push({ file: memoryFile, currentLines, targetLines });
  }

  // Compare MCP servers (from settings.json)
  const readMcpServers = (configPath: string): string[] => {
    const settingsPath = path.join(configPath, 'settings.json');
    if (!fs.existsSync(settingsPath)) return [];
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return Object.keys(settings.mcpServers || {});
    } catch {
      /* settings.json corrupt or unreadable */
      return [];
    }
  };

  const currentMcp = readMcpServers(currentPath);
  const targetMcp = new Set(readMcpServers(targetPath));
  diff.mcp = currentMcp.filter(m => !targetMcp.has(m));

  return diff;
}

/**
 * Check if a ResourceDiff has any differences.
 */
export function hasResourceDiff(diff: ResourceDiff): boolean {
  return (
    diff.commands.length > 0 ||
    diff.skills.length > 0 ||
    diff.hooks.length > 0 ||
    diff.memory.length > 0 ||
    diff.mcp.length > 0
  );
}

/**
 * Copy resources from one version to another.
 * Only copies resources listed in the diff (i.e., ones missing in target).
 */
function copyResourcesToVersion(
  agent: AgentId,
  fromVersion: string,
  toVersion: string,
  diff: ResourceDiff
): void {
  const agentConfig = AGENTS[agent];
  const fromPath = getVersionConfigPath(agent, fromVersion);
  const toPath = getVersionConfigPath(agent, toVersion);

  // Helper to copy a file or directory
  const copyItem = (srcDir: string, destDir: string, name: string): void => {
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);
    if (!fs.existsSync(srcPath)) return;

    fs.mkdirSync(destDir, { recursive: true });

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  };

  // Copy missing commands
  const commandsSubdir = agentConfig.commandsSubdir;
  const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
  for (const cmd of diff.commands) {
    copyItem(
      path.join(fromPath, commandsSubdir),
      path.join(toPath, commandsSubdir),
      `${cmd}${ext}`
    );
  }

  // Copy missing skills
  for (const skill of diff.skills) {
    copyItem(path.join(fromPath, 'skills'), path.join(toPath, 'skills'), skill);
  }

  // Copy missing hooks
  for (const hook of diff.hooks) {
    copyItem(path.join(fromPath, 'hooks'), path.join(toPath, 'hooks'), hook);
  }

  // Copy memory file if different
  for (const mem of diff.memory) {
    const srcPath = path.join(fromPath, mem.file);
    const destPath = path.join(toPath, mem.file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // Merge MCP servers into target settings.json
  if (diff.mcp.length > 0) {
    const fromSettingsPath = path.join(fromPath, 'settings.json');
    const toSettingsPath = path.join(toPath, 'settings.json');

    if (fs.existsSync(fromSettingsPath)) {
      try {
        const fromSettings = JSON.parse(fs.readFileSync(fromSettingsPath, 'utf-8'));
        let toSettings: Record<string, unknown> = {};

        if (fs.existsSync(toSettingsPath)) {
          toSettings = JSON.parse(fs.readFileSync(toSettingsPath, 'utf-8'));
        }

        if (!toSettings.mcpServers) {
          toSettings.mcpServers = {};
        }

        for (const serverName of diff.mcp) {
          if (fromSettings.mcpServers?.[serverName]) {
            (toSettings.mcpServers as Record<string, unknown>)[serverName] = fromSettings.mcpServers[serverName];
          }
        }

        fs.writeFileSync(toSettingsPath, JSON.stringify(toSettings, null, 2));
      } catch {
        /* settings.json parse error, skip MCP merge */
      }
    }
  }
}
