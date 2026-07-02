/**
 * `agents sessions --host <target>` — run the session query on a remote machine
 * over SSH and stream its output back. Session transcripts and the index DB live
 * on the machine that produced them (see `discover.ts`, all `os.homedir()`-rooted),
 * so instead of syncing the bytes here we invoke the *remote's own* `agents
 * sessions` against its already-built index and forward stdout verbatim.
 *
 * This is the live counterpart to `agents sessions sync` (R2/CRDT, eventual): no
 * upfront copy, always current, but the peer must be reachable. SSH access is the
 * only auth — if you can `ssh <host>`, you own the box (no identity layer by design).
 *
 * Offline degradation (no sync, still fetch-first): every *successful* fetch is
 * cached to `~/.agents/.cache/remote-sessions/`, keyed by host + the exact query.
 * When a later run finds the host unreachable, the cache is replayed with a clearly
 * labelled "showing cached results" banner instead of returning nothing. The cache
 * is a byproduct of fetches you already made — never a background job, freely
 * deletable — so the fetch-don't-replicate model holds; this is just graceful
 * degradation when the peer is asleep.
 *
 * Mirrors the transport already used by `agents secrets export --host`
 * (`src/commands/secrets.ts`): `ssh -o BatchMode=yes <host> bash -lc '<cmd>'`,
 * with `bash -lc` so the remote login PATH resolves `agents`.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { getCacheDir } from '../state.js';
import { SSH_OPTS, controlOpts } from '../ssh-exec.js';
import { remoteShellFor, buildWindowsAgentsCommand } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { formatRelativeTime } from './relative-time.js';
import { terminalWidth } from './width.js';

/**
 * SSH target: a bare ssh-config host alias (e.g. `yosemite-s1`) or `user@host`.
 * The strict allowlist blocks shell metacharacters and a leading `-`, so a target
 * can never be smuggled in as an ssh argv flag.
 */
export const SSH_TARGET_RE = /^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/;

export function assertValidSshTarget(host: string): void {
  if (!SSH_TARGET_RE.test(host)) {
    throw new Error(
      `Invalid SSH target ${JSON.stringify(host)}. Expected a host alias or user@host ` +
        `(letters, digits, '.', '_', '-').`,
    );
  }
}

/** POSIX single-quote a string for safe interpolation into a remote shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Strip the `--host`/`-H` flag (and its value) from a raw `agents sessions` argv,
 * leaving the args to forward to the remote unchanged. The remote runs the same
 * binary, so every other flag (`--since`, `--last`, `--json`, query, …) carries
 * over for free. Handles every form commander accepts: `--host h`, `--host=h`,
 * `-H h`, `-H=h`, and the glued short form `-Hh`.
 *
 * @param argv full process argv; the sessions args begin at index 2
 *             (`[runtime, script, 'sessions', ...]`).
 */
export function buildForwardedArgs(argv: string[], hosts: Set<string> = new Set()): string[] {
  const args = argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--host' || a === '-H') {
      // Commander's `<target...>` variadic accepts both `--host a --host b` and
      // `--host a b` — consume every consecutive token that is a known host so
      // the variadic form doesn't leak the extra hosts into the remote argv.
      // Fall back to consuming the single next token when we have no host set
      // (e.g. malformed input) so the flag value never leaks either way.
      if (hosts.size > 0) {
        while (i + 1 < args.length && hosts.has(args[i + 1])) i++;
      } else {
        i++; // also consume the separate value token
      }
      continue;
    }
    if (a.startsWith('--host=') || a.startsWith('-H=')) continue;
    if (/^-H.+/.test(a)) continue; // glued short form: -Hyosemite-s1
    out.push(a);
  }
  return out;
}

/**
 * Build the single remote command string for `ssh <host> <cmd>`. Forwarded args
 * are quoted for the inner login shell, then the whole `agents …` invocation is
 * quoted again so it survives `bash -lc <...>`.
 *
 * `os` selects the remote shell: a Windows host gets a PowerShell invocation
 * (ssh lands in cmd.exe/PowerShell there, where `bash -lc` does not exist);
 * anything else — including unknown/absent — keeps the POSIX form unchanged.
 * The forwarded terminal width rides across as an env var either way so the
 * remote renders its table to the local screen.
 */
export function buildRemoteCommand(forwardedArgs: string[], columns?: number, os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    const env = columns && columns > 0 ? { COLUMNS: String(columns) } : undefined;
    return buildWindowsAgentsCommand({ args: forwardedArgs, env });
  }
  const inner = ['agents', ...forwardedArgs].map(shellQuote).join(' ');
  // Forward the caller's terminal width so the remote renders the table to the
  // local screen (over SSH the remote's own COLUMNS is unset/wrong). `VAR=val
  // cmd` scopes the env to that process — the remote's terminalWidth() reads it.
  const withCols = columns && columns > 0 ? `COLUMNS=${columns} ${inner}` : inner;
  return `bash -lc ${shellQuote(withCols)}`;
}


/** The four outcomes of one `ssh <host> agents sessions …` invocation. */
export type SshOutcome = 'ok' | 'unreachable' | 'query-failed' | 'spawn-error';

/**
 * Classify an ssh `spawnSync` result. ssh(1) reserves exit 255 for its own
 * connection-layer failures (host down, timeout, refused, auth, changed host
 * key) — distinct from any other non-zero, which is the remote `agents sessions`
 * exit code forwarded back (the query ran but failed). The two must be handled
 * differently: 255 may fall back to cache, a forwarded failure must surface.
 */
export function classifySshFailure(res: { error?: Error | null; status: number | null }): SshOutcome {
  if (res.error) return 'spawn-error';
  if (res.status === 0) return 'ok';
  if (res.status === 255) return 'unreachable';
  return 'query-failed';
}

/** Root of the offline-replay cache (`~/.agents/.cache/remote-sessions/`). */
const REMOTE_CACHE_DIR = join(getCacheDir(), 'remote-sessions');

/**
 * Deterministic cache path for a (host, forwarded-args) pair. The forwarded args
 * are hashed so distinct queries cache independently; the host stays readable in
 * the filename (sanitised so `user@host` and aliases are filesystem-safe).
 */
export function remoteCachePath(host: string, forwardedArgs: string[]): string {
  const hash = createHash('sha256').update(forwardedArgs.join('\u0000')).digest('hex').slice(0, 16);
  const safeHost = host.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return join(REMOTE_CACHE_DIR, `${safeHost}__${hash}.txt`);
}

/** Banner shown above replayed cache rows when the peer is offline. */
export function formatStaleBanner(host: string, mtimeMs: number): string {
  const ago = formatRelativeTime(new Date(mtimeMs).toISOString());
  return chalk.yellow(`${host}: offline — showing cached results from ${ago}`);
}

/** Message shown when a host is unreachable and there is no cache to fall back to. */
export function formatUnreachable(host: string): string {
  return chalk.red(
    `${host}: unreachable over SSH (asleep, offline, or host key changed?) — ConnectTimeout 10s`,
  );
}

/** Persist a successful fetch for later offline replay. Best-effort: a cache
 * write must never break the live query. */
function writeRemoteCache(host: string, forwardedArgs: string[], output: string): void {
  try {
    mkdirSync(REMOTE_CACHE_DIR, { recursive: true });
    writeFileSync(remoteCachePath(host, forwardedArgs), output);
  } catch {
    // ignore — caching is an optimisation, not a guarantee
  }
}

/** Replay a cached fetch for an unreachable host. Banner goes to stderr (so a
 * piped stdout stays exactly the cached rows); returns false when nothing is
 * cached for this exact (host, query). */
function replayRemoteCache(host: string, forwardedArgs: string[]): boolean {
  try {
    const p = remoteCachePath(host, forwardedArgs);
    if (!existsSync(p)) return false;
    process.stderr.write(formatStaleBanner(host, statSync(p).mtimeMs) + '\n');
    process.stdout.write(readFileSync(p, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the current `agents sessions` invocation on one or more remote machines over
 * SSH, writing each remote's output to the terminal. A successful fetch is cached;
 * an unreachable host falls back to that cache (with a stale banner) when present.
 * Sets `process.exitCode = 1` if any host could not be answered (live or cached).
 * Reads the invocation from `process.argv` (override via `argv` for testing).
 *
 * Output is captured rather than `stdio: 'inherit'`-streamed so it can be cached.
 * Session output is small and the remote returns quickly, so buffering is
 * imperceptible; `maxBuffer` is generous for the rare large `--markdown <id>` dump.
 */
export function runRemoteSessions(hosts: string[], argv: string[] = process.argv): void {
  for (const host of hosts) assertValidSshTarget(host); // fail fast on any bad target

  const forwarded = buildForwardedArgs(argv, new Set(hosts));
  const cols = terminalWidth();
  const multi = hosts.length > 1;
  let failures = 0;

  for (const host of hosts) {
    if (multi) process.stdout.write(chalk.cyan(`\n── ${host} ──\n`));
    // Per-host: a Windows peer needs a PowerShell command, POSIX peers `bash -lc`.
    const remoteCmd = buildRemoteCommand(forwarded, cols, resolveRemoteOsSync(host));
    const res = spawnSync('ssh', [...SSH_OPTS, ...controlOpts(), host, remoteCmd], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    switch (classifySshFailure(res)) {
      case 'ok':
        process.stdout.write(res.stdout ?? '');
        if (res.stderr) process.stderr.write(res.stderr);
        writeRemoteCache(host, forwarded, res.stdout ?? '');
        break;

      case 'unreachable':
        // Served-from-cache counts as answered (degraded, but with data + a clear
        // banner), so it does not increment failures. No cache → a real failure.
        if (!replayRemoteCache(host, forwarded)) {
          failures++;
          console.error(formatUnreachable(host));
        }
        break;

      case 'spawn-error':
        failures++;
        console.error(chalk.red(`${host}: ${res.error?.message ?? 'failed to launch ssh'}`));
        break;

      case 'query-failed':
        // The remote ran but its query exited non-zero — surface its own output
        // and exit code; never mask a genuine error with stale cache.
        failures++;
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        console.error(chalk.red(`${host}: remote query failed (exit ${res.status ?? 'signal'}).`));
        break;
    }
  }

  if (failures > 0) process.exitCode = 1;
}
