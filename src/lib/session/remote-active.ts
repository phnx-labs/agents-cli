/**
 * Cross-machine fan-out for `agents sessions --active`.
 *
 * A single `getActiveSessions()` only sees the local machine. To show the whole
 * fleet in one view, we run `agents sessions --active --json --local` on each
 * peer over SSH and merge the parsed results, tagging every row with the machine
 * it came from so the renderer can bucket by computer.
 *
 * Peers are the registered, online devices from `ag devices` (or an explicit
 * `--host` list). `--local` on the remote invocation is critical: it stops the
 * peer from fanning out to *its* devices, so the sweep never recurses.
 *
 * A dead or slow host is skipped with a stderr note, never fatal — one asleep
 * laptop must not blank the whole view. SSH runs are async + parallel (a fresh
 * `spawn`, not the sync `sshExec`) so N peers cost one round-trip, not N.
 */
import { spawn } from 'child_process';
import chalk from 'chalk';
import { SSH_OPTS, controlOpts, assertValidSshTarget, shellQuote } from '../ssh-exec.js';
import { sshTargetFor } from '../devices/connect.js';
import { loadDevices, type DeviceProfile } from '../devices/registry.js';
import { machineId, normalizeHost } from './sync/config.js';
import type { ActiveSession } from './active.js';

/** Per-host SSH budget. Slightly above SSH_OPTS' ConnectTimeout=10 so a
 * reachable-but-slow remote still answers before we give up. */
const REMOTE_TIMEOUT_MS = 12_000;

/**
 * Recursion guard, passed as an env var (not a CLI flag) so an OLDER remote
 * `agents` that predates this feature ignores it harmlessly instead of erroring
 * on an unknown option. A remote new enough to fan out reads it and stays local.
 */
export const NO_FANOUT_ENV = 'AGENTS_SESSIONS_LOCAL';

/** The command run on each peer: answer for itself, as JSON, without recursing. */
function remoteActiveCommand(): string {
  const inner = `${NO_FANOUT_ENV}=1 agents sessions --active --json`;
  return `bash -lc ${shellQuote(inner)}`;
}

/**
 * Parse a peer's `--active --json` stdout into active sessions, tagging each
 * with `machine`. Defensive against version skew / partial output: non-JSON or
 * a non-array yields `[]`, and non-object entries are dropped rather than
 * throwing. Exported for unit testing without a live tailnet.
 */
export function parseRemoteActive(stdout: string, machine: string): ActiveSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ActiveSession[] = [];
  for (const x of parsed) {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      out.push({ ...(x as ActiveSession), machine });
    }
  }
  return out;
}

/** Run one remote `agents sessions --active --json --local` and capture stdout.
 * Resolves `{ code: null }` on spawn error or timeout (host treated as dead). */
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

async function fetchByTarget(target: string, machine: string, display: string): Promise<ActiveSession[]> {
  const { code, stdout } = await sshCapture(target, remoteActiveCommand(), REMOTE_TIMEOUT_MS);
  if (code !== 0) {
    process.stderr.write(chalk.gray(`  ${display}: unreachable or no agents CLI — skipped\n`));
    return [];
  }
  return parseRemoteActive(stdout, machine);
}

export interface RemoteActiveResult {
  sessions: ActiveSession[];
  /** How many peer machines we attempted to reach (drives the empty-fleet tip). */
  deviceCount: number;
}

/**
 * Gather active sessions from other machines. With an explicit `hosts` list
 * (from `--host`), fan out to exactly those. Otherwise sweep the registered,
 * online devices from `ag devices`, excluding this machine and any without an
 * address. Results from all peers run in parallel and are flattened.
 */
export async function gatherRemoteActive(hosts?: string[]): Promise<RemoteActiveResult> {
  const self = machineId();
  const targets: Array<{ target: string; machine: string; name: string }> = [];

  if (hosts && hosts.length > 0) {
    for (const h of hosts) {
      try {
        assertValidSshTarget(h);
      } catch {
        process.stderr.write(chalk.gray(`  ${h}: not a valid ssh target — skipped\n`));
        continue;
      }
      const bareHost = h.split('@').pop() || h;
      targets.push({ target: h, machine: normalizeHost(bareHost), name: h });
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
        targets.push({ target: sshTargetFor(d), machine: normalizeHost(d.name), name: d.name });
      } catch {
        // No address on the profile — nothing to dial; skip silently.
      }
    }
  }

  const results = await Promise.all(targets.map((t) => fetchByTarget(t.target, t.machine, t.name)));
  return { sessions: results.flat(), deviceCount: targets.length };
}
