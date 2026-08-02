/**
 * `agents run --lease` orchestrator.
 *
 * Lease an ephemeral crabbox → provision the picked runtime(s) + their
 * credentials → run the agent on the box (via `crabbox run`, which owns the
 * SSH) → tear the box down. The whole box-side sequence rides a single
 * `--script-stdin` body so the token contents never touch argv.
 *
 * ── Command-layer contract (RUSH-1920/1921/1924) ─────────────────────────────
 * Exports the commands layer (exec.ts / lease.ts / ssh.ts) consumes:
 *   • `buildBootstrapScript(opts)` — `opts.copySetup` (default TRUE; clear for
 *     --bare) gates the `copy-setup` progress sentinel; `opts.netMode`
 *     ('public' | 'tailscale', default 'public') adds the `joined-tailnet` step.
 *   • `LeaseRunOptions.copySetup` / `LeaseRunOptions.netMode` — forwarded by
 *     `leaseAndRun` (netMode → `crabboxWarmup`).
 *   • `crabboxWarmup(opts.netMode)` — 'tailscale' leases onto the tailnet
 *     (`--network tailscale -tailscale-tags tag:crabbox`); auth key rides the
 *     child env as `CRABBOX_TAILSCALE_AUTH_KEY` (crabboxEnv, cli.ts).
 *   • `CrabboxBox.tailscaleIPv4` / `CrabboxBox.tailscaleFQDN` — populated from
 *     the box labels by `normalizeBox` (cli.ts).
 *   • Step stream (progress.ts): `type LeaseStep`, the `onStep` router option,
 *     and the self-contained `renderStepLine(step)` helper (the lib never prints).
 *   • Setup-copy (setup-copy.ts): `copySetupToBox({ host, user?, port?,
 *     secretsBundle?, userAgentsDir?, onData? }): Promise<CopySetupResult>` — the
 *     push-from-local the command layer runs before the box run.
 */

import type { AgentId } from '../types.js';
import { crabboxFind, crabboxWarmup, crabboxWaitReady, crabboxRunScript, crabboxStop, type CrabboxBox } from './cli.js';
import * as yaml from 'yaml';
import { buildCredentialScript, buildHomeFileWriteScript, CLAUDE_TOKEN_REMOTE, type DetectedRuntime } from './runtimes.js';
import { LEASE_AGENT_MARKER, leasePhaseSentinel } from './progress.js';
import { copySetupToBox } from './setup-copy.js';

/** Phase signal for a lease run, so the command layer can drive a progress UI. */
export type LeasePhase =
  | { kind: 'warmup'; backend?: string }
  | { kind: 'reuse'; slug: string }
  | { kind: 'ready'; box: CrabboxBox; elapsedMs: number }
  | { kind: 'teardown' };

export interface LeaseRunOptions {
  agent: string;
  prompt: string;
  mode?: string;
  model?: string;
  /** Cloud backend crabbox provisions on (hetzner/aws/do/…). */
  backend?: string;
  boxClass?: string;
  profile?: string;
  /** Runtimes to install on the box. */
  runtimes: AgentId[];
  /** Runtime credentials to copy; defaults to `runtimes`. */
  credentialRuntimes?: AgentId[];
  detected: DetectedRuntime[];
  /** Profile-dispatch config to materialize on the leased box before the run. */
  dispatchProfile?: LeaseDispatchProfile;
  /** Secrets bundle providing crabbox's provider token. */
  secretsBundle?: string;
  /**
   * Push the git-tracked subset of the local `~/.agents` onto the box before the
   * run (default TRUE). The command layer sets `false` for `--bare`. When true,
   * `buildBootstrapScript` emits the `copy-setup` progress sentinel; the actual
   * push-from-local is `copySetupToBox` (setup-copy.ts), which the command layer
   * runs before the box run.
   */
  copySetup?: boolean;
  /**
   * Network mode threaded to `crabboxWarmup` (default `'public'`). `'tailscale'`
   * leases the box onto the tailnet and adds a `joined-tailnet` progress step.
   * The command layer decides WHEN to enable it — this is plumbing only.
   */
  netMode?: 'public' | 'tailscale';
  onData?: (s: string) => void;
  /** Progress phases (warmup → ready → teardown) for a command-layer spinner. */
  onPhase?: (phase: LeasePhase) => void;
  /** Keep the box after the run instead of stopping it. */
  keep?: boolean;
  /** Existing warm crabbox slug to reuse instead of provisioning a new lease. */
  reuseBox?: string;
  /**
   * Raw wrapped Claude OAuth payload (from `resolveClaudeCredentialsBlob`), written
   * to `~/.claude/.credentials.json` on the box. The command layer resolves it
   * (after consent) so this module stays free of Keychain I/O and unit-testable.
   */
  claudeCredentialsJson?: string | null;
}

export interface LeaseDispatchProfile {
  name: string;
  agent: AgentId;
  version?: string;
  env: Record<string, string>;
  description?: string;
  preset?: string;
  provider?: string;
  fallbackModel?: string;
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

function profileRemotePath(name: string): string {
  return `.agents/profiles/${name}.yml`;
}

function buildProfileScript(profile: LeaseDispatchProfile): string {
  const body = yaml.stringify({
    name: profile.name,
    ...(profile.description ? { description: profile.description } : {}),
    host: {
      agent: profile.agent,
      ...(profile.version ? { version: profile.version } : {}),
    },
    env: profile.env,
    ...(profile.fallbackModel ? { fallback_model: profile.fallbackModel } : {}),
    ...(profile.preset ? { preset: profile.preset } : {}),
    ...(profile.provider ? { provider: profile.provider } : {}),
  });
  return buildHomeFileWriteScript(profileRemotePath(profile.name), body);
}

function runtimeInstallSpec(id: AgentId, dispatchProfile?: LeaseDispatchProfile): string {
  if (dispatchProfile?.agent === id && dispatchProfile.version) {
    return `${id}@${dispatchProfile.version}`;
  }
  return id;
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
  const credentialRuntimes = opts.credentialRuntimes ?? opts.runtimes;
  const credScript = buildCredentialScript(credentialRuntimes, opts.detected, {
    claudeCredentialsJson: opts.claudeCredentialsJson,
  });
  const profileScript = opts.dispatchProfile ? buildProfileScript(opts.dispatchProfile) : '';
  const runParts = ['agents', 'run', q(opts.agent), q(opts.prompt), '--quiet'];
  if (opts.mode) runParts.push('--mode', q(opts.mode));
  if (opts.model) runParts.push('--model', q(opts.model));

  // Credential files to shred after the run (home-level paths written above).
  // Runs regardless of --keep-box (it's in the box body, not teardown), so a kept
  // box still loses the token after the run — minimizing the credential window.
  const shredPaths = credentialRuntimes.flatMap((id) => {
    const paths = { claude: ['.claude.json', CLAUDE_TOKEN_REMOTE], codex: ['.codex/auth.json'], gemini: ['.gemini/google_accounts.json'], grok: ['.grok/auth.json'] }[id as string];
    return paths ?? [];
  });
  if (opts.dispatchProfile) shredPaths.push(profileRemotePath(opts.dispatchProfile.name));
  const shred = shredPaths.map((p) => `rm -f "$HOME/${p}" 2>/dev/null || true`).join('\n');

  const installRuntimes = opts.runtimes
    .map((id) => `agents add ${q(runtimeInstallSpec(id, opts.dispatchProfile))} >/dev/null 2>&1 || true`)
    .join('\n');

  // `echo`-ed phase sentinels (progress.ts) let the command layer drive a
  // step-by-step UI. `createLeaseOutputRouter` swallows these lines and surfaces
  // them as a structured step stream — they never appear as setup noise.
  const step = (name: string) => `echo ${q(leasePhaseSentinel(name))}`;
  const copySetup = opts.copySetup !== false; // default TRUE

  return [
    'set -uo pipefail',
    // crabbox has finished its workspace resync by the time this script runs;
    // the sync sentinel marks the transition out of that (crabbox-driven) phase.
    step('sync'),
    // Only meaningful on a tailnet lease — the box already joined during warmup.
    opts.netMode === 'tailscale' ? step('joined-tailnet') : '',
    step('install'),
    ENSURE_AGENTS_CLI,
    step('runtime'),
    installRuntimes,
    step('creds'),
    credScript,
    profileScript,
    // copy-setup: the host already rsync'd the git-tracked ~/.agents onto the box
    // (leaseAndRun, before this script). Here — after ENSURE_AGENTS_CLI installed
    // the CLI — we materialize that config into the runtime home. Gated by
    // copySetup (cleared for --bare). Best-effort; a refresh failure never aborts.
    copySetup ? [step('copy-setup'), 'agents sync --local -y >/dev/null 2>&1 || true'].join('\n') : '',
    // Marker on its own line: the command layer shows everything before this as
    // setup progress and everything after (the agent's output) verbatim.
    `echo ${q(LEASE_AGENT_MARKER)}`,
    `${runParts.join(' ')}`,
    'rc=$?',
    shred,
    'exit $rc',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}

export async function leaseAndRun(opts: LeaseRunOptions): Promise<LeaseRunResult> {
  const startedAt = Date.now();
  let box: CrabboxBox;
  if (opts.reuseBox) {
    opts.onPhase?.({ kind: 'reuse', slug: opts.reuseBox });
    const found = crabboxFind(opts.reuseBox, { secretsBundle: opts.secretsBundle });
    if (!found) throw new Error(`crabbox box "${opts.reuseBox}" was not found. Check \`crabbox list\` or pass a different --box slug.`);
    box = found.ready
      ? found
      : await crabboxWaitReady(opts.reuseBox, { secretsBundle: opts.secretsBundle });
  } else {
    opts.onPhase?.({ kind: 'warmup', backend: opts.backend });
    box = await crabboxWarmup({
      class: opts.boxClass,
      profile: opts.profile,
      provider: opts.backend,
      secretsBundle: opts.secretsBundle,
      netMode: opts.netMode,
    });
    await crabboxWaitReady(box.slug, { secretsBundle: opts.secretsBundle });
  }
  opts.onPhase?.({ kind: 'ready', box, elapsedMs: Date.now() - startedAt });

  // Setup-copy (F1, RUSH-1920): push the git-tracked ~/.agents config onto the
  // box from the host, over crabbox's own per-lease ssh (a raw ssh fails
  // publickey). rsync only here — the box has no agents-cli yet, so the matching
  // `agents sync --local` runs inside the bootstrap script, after the install
  // step. Best-effort: a copy failure never aborts the run (the agent just runs
  // without the config).
  if (opts.copySetup !== false) {
    try {
      await copySetupToBox({
        slug: box.slug,
        secretsBundle: opts.secretsBundle,
        onData: opts.onData,
        refresh: false,
      });
    } catch {
      /* best-effort — never block the run on a config-copy failure */
    }
  }

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
    // caller explicitly asked to keep the box or targeted an existing warm box.
    if (!opts.keep && !opts.reuseBox) {
      opts.onPhase?.({ kind: 'teardown' });
      toreDown = crabboxStop(box.slug, { secretsBundle: opts.secretsBundle });
    }
  }
  return { box, exitCode, toreDown };
}
