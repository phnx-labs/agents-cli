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
import { gatherRemoteAgentsJson, type RemoteAgentsJsonParseResult } from '../remote-agents-json.js';
import { normalizeHost } from './sync/config.js';
import { NO_FANOUT_ENV } from './remote-active.js';
import { terminalWidth } from './width.js';
import type { SessionMeta } from './types.js';

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
  return parsed.flatMap((value) => value && typeof value === 'object' && !Array.isArray(value)
    ? [{ ...(value as SessionMeta), machine, _remote: true }]
    : []);
}

/** Strict parser used at the live peer boundary. A successful process with
 * malformed/non-array JSON is an incomplete source, not an empty machine. */
const SAFE_RESOLVER_KEYS = new Set([
  'id', 'shortId', 'agent', 'origin', 'timestamp', 'lastActivity', 'project',
  'version', 'label', 'topic', 'machine',
]);

function isSafeResolverRow(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string' || typeof value.shortId !== 'string'
    || typeof value.agent !== 'string' || typeof value.timestamp !== 'string') return false;
  return Object.keys(value).every(key => SAFE_RESOLVER_KEYS.has(key));
}

export function parseRemoteListPayload(stdout: string, machine: string, safeResolver = false): {
  items: SessionMeta[];
  valid: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { items: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { items: [], valid: false };
  const out: SessionMeta[] = [];
  for (const x of parsed) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { items: [], valid: false };
    if (safeResolver && !isSafeResolverRow(x as Record<string, unknown>)) {
      return { items: [], valid: false };
    }
    // `_remote` marks these as living on the peer's disk (not a local mirror),
    // so the picker routes read/resume back over SSH instead of the local FS.
    out.push({ ...(x as SessionMeta), machine, _remote: true });
  }
  return { items: out, valid: true };
}

export interface RemoteListResult {
  sessions: SessionMeta[];
  /** How many peer machines we attempted to reach (drives the empty-fleet tip). */
  deviceCount: number;
  /**
   * Peers that failed to answer, by display name. The stderr note above is
   * enough for a printed listing, but the interactive browser repaints over it —
   * so callers rendering a full-screen UI need the outcome as data to tell
   * "that box is asleep" apart from "that box has no matching sessions".
   */
  unreachable: string[];
}

/**
 * Gather listing sessions from other machines. With an explicit `hosts` list
 * (from `--host`), fan out to exactly those. Otherwise sweep the registered,
 * online devices from `ag devices`, excluding this machine and any without an
 * address. `forwardedArgs` are the caller's own sessions args (query + filters,
 * already `--json`) so every peer returns the same slice this machine asked for.
 */
export async function gatherRemoteList(forwardedArgs: string[], hosts?: string[]): Promise<RemoteListResult> {
  const safeResolver = forwardedArgs.includes('--resolve-safe-v1');
  const result = await gatherRemoteAgentsJson<SessionMeta>({
    args: forwardedArgs,
    noFanoutEnv: NO_FANOUT_ENV,
    hosts,
    parse: (stdout, machine): RemoteAgentsJsonParseResult<SessionMeta> =>
      parseRemoteListPayload(stdout, machine, safeResolver),
  });
  return {
    sessions: result.items,
    deviceCount: result.deviceCount,
    unreachable: [
      ...(result.discoveryFailed ? ['device registry'] : []),
      ...result.skipped,
      ...result.parseFailed,
    ],
  };
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
