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
import { gatherRemoteAgentsJson } from '../remote-agents-json.js';
import type { ActiveSession } from './active.js';
import { parseViewingIn } from './viewing-in.js';

/**
 * Recursion guard, passed as an env var (not a CLI flag) so an OLDER remote
 * `agents` that predates this feature ignores it harmlessly instead of erroring
 * on an unknown option. A remote new enough to fan out reads it and stays local.
 */
export const NO_FANOUT_ENV = 'AGENTS_SESSIONS_LOCAL';

/**
 * Parse a peer's `--active --json` stdout into active sessions, tagging each
 * with `machine`. Defensive against version skew / partial output: non-JSON or
 * a non-array yields `[]`, and non-object entries are dropped rather than
 * throwing. `viewingIn` arrives as a display string from a current peer and as
 * an `{app, tab}` object from one that predates the flattening, so it is
 * normalized here — the single boundary where a foreign row becomes internal.
 * Exported for unit testing without a live tailnet.
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
      // The dialed machine still wins by default. That is deliberate: the peer
      // reports `machineId()` (its hostname) while we key on the REGISTERED
      // device name, and stamping ours is the only thing reconciling the two —
      // drop it and a device whose registered name differs from its hostname
      // silently answers a `--device <name>` scope with zero rows.
      //
      // The one row that must keep its own answer is an offloaded run, whose
      // execution host is a THIRD box, not the peer we dialed
      // (foldExecutionMachine, RUSH-2479). `offloadedFrom` marks exactly that
      // row, so it is the discriminator rather than "the peer said something".
      const reported = x as ActiveSession;
      const row = {
        ...reported,
        machine: reported.offloadedFrom && reported.machine ? reported.machine : machine,
      };
      row.viewingIn = parseViewingIn((x as { viewingIn?: unknown }).viewingIn);
      out.push(row);
    }
  }
  return out;
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
 * `opts.quiet` suppresses the per-device stderr line for callers that report
 * skipped peers once, compactly, themselves.
 */
export async function gatherRemoteActive(hosts?: string[], opts?: { quiet?: boolean }): Promise<RemoteActiveResult> {
  const result = await gatherRemoteAgentsJson({
    args: ['sessions', '--active', '--json'],
    noFanoutEnv: NO_FANOUT_ENV,
    hosts,
    parse: parseRemoteActive,
    quiet: opts?.quiet,
  });
  return { sessions: result.items, deviceCount: result.deviceCount };
}
