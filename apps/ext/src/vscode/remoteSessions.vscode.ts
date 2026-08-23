// Bounded, user-triggered session history and detail reads.
// Live session state is owned by `agents sessions watch --json` and projected by
// SessionPresentationStore; this module never polls or reconstructs that state.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { homedir } from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import {
  RemoteSession,
  ReconciledHost,
  RegisteredDeviceInput,
  normalizeRecentSession,
  resolveSessionHost,
  normalizeHost,
  reconcileHosts,
  parseSessionLabelSource,
  SessionLabelSource,
  parseSessionIdentity,
  SessionIdentity,
} from '../core/remoteSessions';
import type { ProjectRule } from '../core/settings';
import {
  getRegisteredDevicesCache,
  listRegisteredDevices,
  type DeviceRef,
} from './deviceHealth.vscode';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** This machine's name — its local sessions are queried directly (no SSH). */
export const LOCAL_HOST = os.hostname();
/** Canonical label the webview uses for this machine. The real os.hostname() is
 *  kept only for SSH/isLocal detection; every host string that crosses to the UI
 *  is normalized to this so the 'this-mac' checks there actually match. */
export const LOCAL_LABEL = 'this-mac';
/** This machine's normalized device id (machineId() form), used to recognize the
 *  CLI's own `machine` tag on local rows and fold them back to LOCAL_LABEL. */
export const LOCAL_MACHINE_ID = normalizeHost(LOCAL_HOST);

const HISTORY_TIMEOUT_LOCAL_MS = 6000;
const HISTORY_TIMEOUT_REMOTE_MS = 10000;
const DETAIL_TIMEOUT_MS = 15000;

/** Run `tasks` with at most `limit` in flight at once, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return out;
}

// Common CLI install dirs a GUI-launched editor's PATH usually MISSES. A raw
// exec (no login shell) on macOS often has only /usr/bin:/bin, so `which agents`
// and `ssh` fail even though a terminal finds them. We prepend these to PATH for
// every shell-out here. (Homebrew first so the running install wins over the
// stale ~/.hermes copy that triggers the CLI's "multiple installs" warning.)
const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(homedir(), '.local', 'bin'),
  path.join(homedir(), '.bun', 'bin'),
];
function pathAugmentedEnv(): NodeJS.ProcessEnv {
  const extra = EXTRA_BIN_DIRS.join(':');
  return { ...process.env, PATH: `${extra}:${process.env.PATH || ''}` };
}

// Resolve the `agents` binary once. The extension-host PATH can differ from an
// interactive shell's, so try `which` with an augmented PATH, then fall back to
// probing known install dirs directly (mirrors linear.vscode.ts:findLinearCli).
let cachedAgentsPath: string | null = null;
async function findAgentsCli(): Promise<string> {
  if (cachedAgentsPath !== null) return cachedAgentsPath || 'agents';
  try {
    const { stdout } = await execAsync('which agents', { env: pathAugmentedEnv() });
    const p = stdout.trim();
    if (p) {
      cachedAgentsPath = p;
      return p;
    }
  } catch {
    // fall through to direct probing
  }
  for (const dir of EXTRA_BIN_DIRS) {
    const candidate = path.join(dir, 'agents');
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      cachedAgentsPath = candidate;
      return candidate;
    } catch {
      // keep probing
    }
  }
  cachedAgentsPath = '';
  return 'agents';
}

// --- Host discovery ---------------------------------------------------------

/**
 * Enumerate the swept host roster from the DEVICE REGISTRY (`agents devices list`)
 * + the local machine — NOT ssh-config aliases or raw tailnet peers, which are not
 * dev machines and previously flooded the sidebar with phantom hosts. The registry
 * is the canonical device set (the same source listRegisteredDevices feeds the
 * dispatch panel); reconcileHosts folds a registry entry that is the local machine
 * into the always-online local host so each machine appears exactly once under its
 * canonical name. The pure scoping/folding lives in core (reconcileHosts) so it is
 * unit-tested; this wrapper only does the I/O. Pass an already-fetched device
 * list to skip the registry read (the host picker's refresh path fetches once
 * and threads the same list through).
 */
export async function discoverHosts(devices?: readonly DeviceRef[]): Promise<ReconciledHost[]> {
  const registered = devices ?? getRegisteredDevicesCache() ?? await listRegisteredDevices();
  const inputs: RegisteredDeviceInput[] = registered.map((d) => ({
    name: d.name,
    address: d.host,
    online: d.online === true,
  }));
  return reconcileHosts(inputs, LOCAL_HOST);
}

/**
 * Recent (historical, non-active) sessions for one host — what the Floor shows when a
 * host filter has 0 live agents instead of a blank pane. Uses the clean-array
 * `agents sessions --json [--device <t>] --limit N` path (flat SessionMeta), normalized
 * onto the same RemoteSession shape as active sessions so the card path is identical.
 * Fetched lazily (only when a host is empty), never on the hot poll.
 */
export async function fetchRecentForHost(
  sshTarget: string,
  isLocal: boolean,
  hostKey: string,
  limit: number,
  projectRules: ProjectRule[],
): Promise<RemoteSession[]> {
  const agentsBin = await findAgentsCli();
  const fetchedAt = Date.now();
  const args = ['sessions', '--json', '--limit', String(limit)];
  if (isLocal) args.push('--local');
  else args.push('--device', sshTarget);
  try {
    const { stdout } = await execFileAsync(agentsBin, args, {
      timeout: isLocal ? HISTORY_TIMEOUT_LOCAL_MS : HISTORY_TIMEOUT_REMOTE_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: pathAugmentedEnv(),
    });
    const parsed = JSON.parse(stdout);
    const raw: any[] = Array.isArray(parsed) ? parsed : [];
    return raw
      .filter((rec) => rec && typeof rec === 'object')
      .map((rec) => normalizeRecentSession(
        rec,
        resolveSessionHost(rec.machine, hostKey, LOCAL_MACHINE_ID, LOCAL_LABEL),
        fetchedAt,
        projectRules,
      ));
  } catch {
    // An older agents-cli (before the clean `--device --json` array) streams a
    // non-JSON banner, so JSON.parse throws -> no recent shown. Graceful: the RECENT
    // section simply stays empty until the engine change is released.
    return [];
  }
}

/**
 * Label inputs for ONE session that lives on another machine.
 *
 * A tab spawned with `agents run --device` has its transcript on the host, so the
 * local by-session-id lookups the label poller normally uses (the Claude
 * sessions/*.json scan, the jsonl preview read) find nothing and the tab keeps
 * the bare agent prefix forever. `agents sessions <id> --device <name> --json`
 * resolves both fields on the machine that owns the session. `--host` was
 * removed in RUSH-2494; passing it makes commander reject the whole lookup.
 *
 * `host` is optional: omit it and the CLI fans the id out across the fleet
 * (the default). A `--device auto` tab that never recorded which box the CLI
 * picked still gets a title this way.
 *
 * Returns null when the host is unreachable or the session is not indexed there
 * yet — a fresh session has no first message for a second or two, and the poller
 * simply retries on its next tick.
 */
export async function fetchRemoteSessionLabelSource(
  sessionId: string,
  host?: string,
): Promise<SessionLabelSource | null> {
  const agentsBin = await findAgentsCli();
  const args = ['sessions', sessionId, '--json'];
  if (host) args.push('--device', host);
  try {
    const { stdout } = await execFileAsync(
      agentsBin,
      args,
      { timeout: DETAIL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: pathAugmentedEnv() },
    );
    return parseSessionLabelSource(stdout, sessionId);
  } catch {
    return null;
  }
}

/**
 * Resolve a running session's real `version` + `account` via
 * `agents sessions <id> [--device <device>] --json`. `host` is passed for an
 * offloaded (`--device`) tab whose session lives on another machine; omitted for a
 * local session. This is the authoritative source for the status bar's
 * version/account — `agents view` reports only machine-default install metadata.
 *
 * Returns null when the host is unreachable or the session is not indexed yet;
 * the status-bar hydration simply retries on its next tick.
 */
export async function fetchSessionIdentity(
  sessionId: string,
  host?: string,
): Promise<SessionIdentity | null> {
  const agentsBin = await findAgentsCli();
  const args = host
    ? ['sessions', sessionId, '--device', host, '--json']
    : ['sessions', sessionId, '--json'];
  try {
    const { stdout } = await execFileAsync(
      agentsBin,
      args,
      { timeout: DETAIL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: pathAugmentedEnv() },
    );
    return parseSessionIdentity(stdout, sessionId);
  } catch {
    return null;
  }
}

/**
 * Recap fan-out: recent (historical) sessions across the WHOLE fleet — the local
 * machine plus every online registered device — flattened and sorted by last
 * activity, newest first. Feeds the Floor's Recap ledger ("what happened while I
 * was away"), so unlike fetchRecentForHost's lazy per-host path this sweeps all
 * hosts at once. Unreachable hosts contribute nothing (fetchRecentForHost already
 * swallows per-host failures); the sweep itself never throws.
 */
export async function fetchRecapSessions(
  limitPerHost: number,
  projectRules: ProjectRule[],
  devices?: readonly DeviceRef[],
): Promise<RemoteSession[]> {
  const hosts = await discoverHosts(devices);
  const targets = hosts.filter((h) => h.isLocal || h.online);
  const results = await Promise.allSettled(
    targets.map((h) => fetchRecentForHost(h.isLocal ? LOCAL_LABEL : h.address, h.isLocal, h.name, limitPerHost, projectRules)),
  );
  const sessions = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return sessions.sort((a, b) => (b.lastActivityMs || b.startedAtMs) - (a.lastActivityMs || a.startedAtMs));
}

// --- Tier-2: rich detail ----------------------------------------------------

export interface HostSessionDetail {
  host: string;
  sessionId: string;
  markdown: string;
  error?: string;
}

/**
 * Tier-2: render one remote (or local) session as markdown on demand. Runs
 * `agents sessions <id> --markdown --include tools`, over SSH via --device for
 * remote machines. Returns an error string rather than throwing.
 */
export async function fetchHostSessionDetail(
  host: string,
  sessionId: string
): Promise<HostSessionDetail> {
  const agentsBin = await findAgentsCli();
  const isLocal = host === LOCAL_HOST || host === LOCAL_LABEL;
  const args = ['sessions', sessionId, '--markdown', '--include', 'tools'];
  if (!isLocal) args.push('--device', host);
  try {
    const { stdout } = await execFileAsync(agentsBin, args, {
      timeout: DETAIL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: pathAugmentedEnv(),
    });
    return { host, sessionId, markdown: stdout };
  } catch (err) {
    return {
      host,
      sessionId,
      markdown: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
