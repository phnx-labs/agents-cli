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
import { buildCredentialScript, type DetectedRuntime } from './runtimes.js';

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
 * Build the single bootstrap script run on the box: ensure agents-cli, install
 * the picked runtime CLIs, write their credentials, run the agent, then shred
 * the credential files. Best-effort install steps never abort the run.
 */
export function buildBootstrapScript(opts: LeaseRunOptions): string {
  const credScript = buildCredentialScript(opts.runtimes, opts.detected);
  const runParts = ['agents', 'run', q(opts.agent), q(opts.prompt), '--quiet'];
  if (opts.mode) runParts.push('--mode', q(opts.mode));
  if (opts.model) runParts.push('--model', q(opts.model));

  // Credential files to shred after the run (home-level paths written above).
  const shred = opts.runtimes
    .map((id) => {
      const cred = { claude: '.claude.json', codex: '.codex/auth.json', gemini: '.gemini/google_accounts.json', grok: '.grok/auth.json' }[id as string];
      return cred ? `rm -f "$HOME/${cred}" 2>/dev/null || true` : '';
    })
    .filter(Boolean)
    .join('\n');

  const installRuntimes = opts.runtimes.map((id) => `agents add ${q(id)} >/dev/null 2>&1 || true`).join('\n');

  return [
    'set -uo pipefail',
    'if ! command -v agents >/dev/null 2>&1; then npm install -g @phnx-labs/agents-cli >/dev/null 2>&1 || true; fi',
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
