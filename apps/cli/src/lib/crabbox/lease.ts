/**
 * `agents run --lease` orchestrator.
 *
 * Lease an ephemeral crabbox → provision the picked runtime(s) + their
 * credentials → run the agent on the box (via `crabbox run`, which owns the
 * SSH) → tear the box down. The whole box-side sequence rides a single
 * `--script-stdin` body so the token contents never touch argv.
 */

import type { AgentId } from '../types.js';
import { crabboxWarmup, crabboxWaitReady, crabboxRunScript, crabboxStop, type CrabboxBox } from './cli.js';
import { buildCredentialScript, CLAUDE_TOKEN_REMOTE, type DetectedRuntime } from './runtimes.js';

export interface LeaseRunOptions {
  agent: string;
  prompt: string;
  mode?: string;
  model?: string;
  /** Cloud backend crabbox provisions on (hetzner/aws/do/…). */
  backend?: string;
  boxClass?: string;
  profile?: string;
  /** Runtimes to install + authenticate on the box (from the picker). */
  runtimes: AgentId[];
  detected: DetectedRuntime[];
  /** Secrets bundle providing crabbox's provider token. */
  secretsBundle?: string;
  onData?: (s: string) => void;
  /** Keep the box after the run instead of stopping it. */
  keep?: boolean;
  /**
   * Raw wrapped Claude OAuth payload (from `resolveClaudeCredentialsBlob`), written
   * to `~/.claude/.credentials.json` on the box. The command layer resolves it
   * (after consent) so this module stays free of Keychain I/O and unit-testable.
   */
  claudeCredentialsJson?: string | null;
}

export interface LeaseRunResult {
  box: CrabboxBox;
  exitCode: number | null;
  toreDown: boolean;
}

/** POSIX single-quote for safe embedding in the generated bootstrap script. */
function q(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Bash snippet that guarantees `agents` is runnable on the box. Fresh crabbox
 * images ship without node, and the box user may not own the global npm prefix,
 * so everything installs user-level under ~/.local (node from the official
 * latest-v22.x tarball to satisfy engines.node >=22.5.0). Exits 96 with a
 * diagnostic when the CLI still isn't runnable — a silent `|| true` here used
 * to surface only as `agents: command not found` deep in the script.
 */
const ENSURE_AGENTS_CLI = [
  'export PATH="$HOME/.local/bin:$PATH"',
  'if ! command -v node >/dev/null 2>&1; then',
  '  case "$(uname -m)" in aarch64|arm64) narch=arm64;; *) narch=x64;; esac',
  '  nver=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE "v22\\.[0-9]+\\.[0-9]+" | head -1)',
  '  mkdir -p "$HOME/.local"',
  '  curl -fsSL "https://nodejs.org/dist/latest-v22.x/node-$nver-linux-$narch.tar.xz" | tar -xJ -C "$HOME/.local" --strip-components=1',
  'fi',
  'if ! command -v agents >/dev/null 2>&1; then',
  '  npm config set prefix "$HOME/.local" >/dev/null 2>&1 || true',
  '  npm install -g @phnx-labs/agents-cli >/dev/null 2>&1',
  'fi',
  'if ! command -v agents >/dev/null 2>&1; then',
  '  echo "lease bootstrap: agents-cli install failed (node: $(command -v node || echo missing))" >&2',
  '  exit 96',
  'fi',
  // Same first-run guard the hosts bootstrap uses (hosts/ready.ts) — a fresh
  // install refuses `agents run` with "agents-cli is not set up" until setup ran.
  'if [ ! -d "$HOME/.agents/.system" ]; then agents setup >/dev/null 2>&1 || true; fi',
].join('\n');

/**
 * Build the single bootstrap script run on the box: ensure agents-cli, install
 * the picked runtime CLIs, write their credentials, run the agent, then shred
 * the credential files. Best-effort install steps never abort the run.
 */
export function buildBootstrapScript(opts: LeaseRunOptions): string {
  const credScript = buildCredentialScript(opts.runtimes, opts.detected, {
    claudeCredentialsJson: opts.claudeCredentialsJson,
  });
  const runParts = ['agents', 'run', q(opts.agent), q(opts.prompt), '--quiet'];
  if (opts.mode) runParts.push('--mode', q(opts.mode));
  if (opts.model) runParts.push('--model', q(opts.model));

  // Credential files to shred after the run (home-level paths written above).
  // Runs regardless of --keep-box (it's in the box body, not teardown), so a kept
  // box still loses the token after the run — minimizing the credential window.
  const shredPaths = opts.runtimes.flatMap((id) => {
    const paths = { claude: ['.claude.json', CLAUDE_TOKEN_REMOTE], codex: ['.codex/auth.json'], gemini: ['.gemini/google_accounts.json'], grok: ['.grok/auth.json'] }[id as string];
    return paths ?? [];
  });
  const shred = shredPaths.map((p) => `rm -f "$HOME/${p}" 2>/dev/null || true`).join('\n');

  const installRuntimes = opts.runtimes.map((id) => `agents add ${q(id)} >/dev/null 2>&1 || true`).join('\n');

  return [
    'set -uo pipefail',
    ENSURE_AGENTS_CLI,
    installRuntimes,
    credScript,
    `${runParts.join(' ')}`,
    'rc=$?',
    shred,
    'exit $rc',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

export async function leaseAndRun(opts: LeaseRunOptions): Promise<LeaseRunResult> {
  const box = crabboxWarmup({
    class: opts.boxClass,
    profile: opts.profile,
    provider: opts.backend,
    secretsBundle: opts.secretsBundle,
  });
  await crabboxWaitReady(box.slug, { secretsBundle: opts.secretsBundle });

  const script = buildBootstrapScript(opts);
  let exitCode: number | null = null;
  let toreDown = false;
  try {
    exitCode = await crabboxRunScript(box.slug, script, {
      secretsBundle: opts.secretsBundle,
      onData: opts.onData,
    });
  } finally {
    // Always attempt teardown (bounds credential lifetime to the run) unless the
    // caller explicitly asked to keep the box.
    if (!opts.keep) toreDown = crabboxStop(box.slug, { secretsBundle: opts.secretsBundle });
  }
  return { box, exitCode, toreDown };
}
