/**
 * Cross-machine fan-out for the default `agents sessions` listing.
 *
 * `discoverSessions()` only scans the local disk. To browse the whole fleet in
 * one list — without syncing anything — we run `agents sessions <same query>
 * --json` on each peer over SSH and merge the parsed `SessionMeta[]`, tagging
 * every row with the machine it came from so the picker/table can label and
 * group by computer.
 *
 * This is the browse-listing sibling of `remote-active.ts` (which fans out
 * `--active`): same transport, same device set, same recursion guard. The peer
 * runs with `AGENTS_SESSIONS_LOCAL=1` so it answers only for itself and the
 * sweep never recurses. A dead or slow host is skipped with a stderr note,
 * never fatal — one asleep laptop must not blank the list.
 */
import { spawn } from 'child_process';
import chalk from 'chalk';
import { SSH_OPTS, controlOpts, assertValidSshTarget, shellQuote } from '../ssh-exec.js';
import { sshTargetFor } from '../devices/connect.js';
import { loadDevices, type DeviceProfile } from '../devices/registry.js';
import { remoteShellFor, buildWindowsAgentsCommand } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { machineId, normalizeHost } from './sync/config.js';
import { NO_FANOUT_ENV } from './remote-active.js';
import { terminalWidth } from './width.js';
import type { SessionMeta } from './types.js';

/** Per-host SSH budget. Slightly above SSH_OPTS' ConnectTimeout=10 so a
 * reachable-but-slow remote still answers before we give up. */
const REMOTE_TIMEOUT_MS = 12_000;

/**
 * The command run on each peer: answer for itself, as JSON, without recursing.
 * `forwardedArgs` carry the caller's own query/filters (already including the
 * leading `sessions` and a `--json`) so each peer returns a comparable slice.
 * A Windows peer gets a PowerShell invocation (ssh lands in cmd.exe/PowerShell
 * there, where `bash -lc` is not a command); every other OS keeps `bash -lc`.
 */
export function remoteListCommand(forwardedArgs: string[], os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({
      args: forwardedArgs,
      env: { [NO_FANOUT_ENV]: '1' },
    });
  }
  const inner = [`${NO_FANOUT_ENV}=1`, 'agents', ...forwardedArgs].map((t, i) =>
    i === 0 ? t : shellQuote(t),
  ).join(' ');
  return `bash -lc ${shellQuote(inner)}`;
}

/**
 * Parse a peer's `sessions --json` stdout into `SessionMeta[]`, tagging each
 * with `machine`. Defensive against version skew / partial output: non-JSON or
 * a non-array yields `[]`, and non-object entries are dropped rather than
 * throwing. The `machine` we dialed always wins over any value the peer set on
 * its own rows, so grouping keys off the computer we asked. Exported for unit
 * testing without a live tailnet.
 */
export function parseRemoteList(stdout: string, machine: string): SessionMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SessionMeta[] = [];
  for (const x of parsed) {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      // `_remote` marks these as living on the peer's disk (not a local mirror),
      // so the picker routes read/resume back over SSH instead of the local FS.
      out.push({ ...(x as SessionMeta), machine, _remote: true });
    }
  }
  return out;
}

/** Run one remote `agents sessions … --json` and capture stdout. Resolves
 * `{ code: null }` on spawn error or timeout (host treated as dead). */
function sshCapture(target: string, remoteCmd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  assertValidSshTarget(target);
  return new Promise((resolve) => {
    const args = [...SSH_OPTS, ...controlOpts(), target, remoteCmd];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

async function fetchByTarget(target: string, machine: string, display: string, forwardedArgs: string[], os?: string): Promise<SessionMeta[]> {
  const { code, stdout } = await sshCapture(target, remoteListCommand(forwardedArgs, os), REMOTE_TIMEOUT_MS);
  if (code !== 0) {
    process.stderr.write(chalk.gray(`  ${display}: unreachable or no agents CLI — skipped\n`));
    return [];
  }
  return parseRemoteList(stdout, machine);
}

export interface RemoteListResult {
  sessions: SessionMeta[];
  /** How many peer machines we attempted to reach (drives the empty-fleet tip). */
  deviceCount: number;
}

/**
 * Gather listing sessions from other machines. With an explicit `hosts` list
 * (from `--host`), fan out to exactly those. Otherwise sweep the registered,
 * online devices from `ag devices`, excluding this machine and any without an
 * address. `forwardedArgs` are the caller's own sessions args (query + filters,
 * already `--json`) so every peer returns the same slice this machine asked for.
 */
export async function gatherRemoteList(forwardedArgs: string[], hosts?: string[]): Promise<RemoteListResult> {
  const self = machineId();
  const targets: Array<{ target: string; machine: string; name: string; os?: string }> = [];

  if (hosts && hosts.length > 0) {
    for (const h of hosts) {
      try {
        assertValidSshTarget(h);
      } catch {
        process.stderr.write(chalk.gray(`  ${h}: not a valid ssh target — skipped\n`));
        continue;
      }
      const bareHost = h.split('@').pop() || h;
      targets.push({ target: h, machine: normalizeHost(bareHost), name: h, os: resolveRemoteOsSync(h) });
    }
  } else {
    let reg: Record<string, DeviceProfile>;
    try {
      reg = await loadDevices();
    } catch {
      return { sessions: [], deviceCount: 0 };
    }
    for (const d of Object.values(reg)) {
      if (d.tailscale?.online !== true) continue;
      if (normalizeHost(d.name) === self) continue;
      // Only machines that can actually run the CLI. iOS/tablet nodes register as
      // `unknown` platform and can never answer, so skip them rather than burn a
      // full ConnectTimeout on each.
      if (d.platform !== 'windows' && d.platform !== 'linux' && d.platform !== 'macos') continue;
      try {
        targets.push({ target: sshTargetFor(d), machine: normalizeHost(d.name), name: d.name, os: d.platform });
      } catch {
        // No address on the profile — nothing to dial; skip silently.
      }
    }
  }

  const results = await Promise.all(targets.map((t) => fetchByTarget(t.target, t.machine, t.name, forwardedArgs, t.os)));
  return { sessions: results.flat(), deviceCount: targets.length };
}

/** Resolve a peer's SSH target (and OS) from the device registry by its
 * normalized machine id — the same id the fan-out tags rows with. Returns
 * undefined when no registered device with an address matches. */
export async function resolvePeerTarget(machine: string): Promise<{ target: string; os?: string } | undefined> {
  let reg: Record<string, DeviceProfile>;
  try {
    reg = await loadDevices();
  } catch {
    return undefined;
  }
  for (const d of Object.values(reg)) {
    if (normalizeHost(d.name) !== machine) continue;
    try {
      return { target: sshTargetFor(d), os: d.platform };
    } catch {
      return undefined; // matched the machine, but it has no address to dial
    }
  }
  return undefined;
}

/**
 * Run `agents <args>` ON a peer over SSH, attached to this terminal (inherited
 * stdio). `args` is the full arg vector after the binary — callers pass e.g.
 * `['sessions', id, '--markdown']` or `['sessions', 'resume', id]`. Used when a
 * picked session lives on another machine: its transcript and agent binary are
 * there, so both reading (no TTY) and resuming (TTY) must execute on the peer —
 * not via a local `--host` hop, which would discover locally and dead-end for a
 * session that exists only on the peer. Resolves 'no-target' when the machine
 * isn't a dialable registered device; the caller surfaces a clear message.
 */
export async function runOnPeer(args: string[], machine: string, opts: { tty?: boolean } = {}): Promise<'ok' | 'no-target'> {
  const peer = await resolvePeerTarget(machine);
  if (!peer) return 'no-target';
  assertValidSshTarget(peer.target); // registry-sourced, but validate like the fan-out does

  const cols = terminalWidth();
  const remoteCmd = remoteShellFor(peer.os) === 'powershell'
    ? buildWindowsAgentsCommand({ args, env: cols > 0 ? { COLUMNS: String(cols) } : undefined })
    : `bash -lc ${shellQuote((cols > 0 ? [`COLUMNS=${cols}`] : []).concat(['agents', ...args].map(shellQuote)).join(' '))}`;

  const sshArgs = [...SSH_OPTS, ...controlOpts()];
  if (opts.tty) sshArgs.push('-tt'); // force a PTY so the resumed agent is interactive
  sshArgs.push(peer.target, remoteCmd);

  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs, { stdio: 'inherit' });
    // ssh prints its own connection errors to the inherited stderr; a spawn
    // failure (e.g. ssh not on PATH) has no such output, so name it. Either way
    // we resolve once it settles so the picker flow completes.
    child.on('error', (err: any) => {
      process.stderr.write(chalk.red(`Failed to reach ${machine}: ${err?.message ?? 'ssh failed to launch'}\n`));
      resolve('ok');
    });
    child.on('close', () => resolve('ok'));
  });
}
