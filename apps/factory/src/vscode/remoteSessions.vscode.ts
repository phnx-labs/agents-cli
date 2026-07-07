// Cross-host session aggregation — SSH fan-out + host discovery (extension host).
//
// Discovers machines from the `agents devices` registry + the local machine (see
// discoverHosts / core reconcileHosts — NOT ssh-config aliases or tailnet peers),
// then shells out to the `agents` CLI on each — locally for this machine, over SSH
// (`--host`) for the rest — to list active sessions (Tier-1) and, on demand, render
// one session as markdown (Tier-2). All parsing/normalizing lives in the pure core
// module (src/core/remoteSessions.ts); this file only does I/O + fan-out + caching.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { homedir } from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import {
  RemoteSession,
  HostInfo,
  HostGroup,
  ReconciledHost,
  RegisteredDeviceInput,
  normalizeActiveSession,
  dedupeSessions,
  filterStaleSessions,
  reconcileHosts,
  enrichWithSessionContent,
  groupByHost,
} from '../core/remoteSessions';
import type { ProjectRule } from '../core/settings';
import { deriveHostLoad, parseRemoteCpuRatio } from '../core/dispatchRanking';
import { listRegisteredDevices } from './deviceHealth.vscode';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** This machine's name — its local sessions are queried directly (no SSH). */
export const LOCAL_HOST = os.hostname();
/** Canonical label the webview uses for this machine. The real os.hostname() is
 *  kept only for SSH/isLocal detection; every host string that crosses to the UI
 *  is normalized to this so the 'this-mac' checks there actually match. */
export const LOCAL_LABEL = 'this-mac';

const ACTIVE_TIMEOUT_LOCAL_MS = 6000;
const ACTIVE_TIMEOUT_REMOTE_MS = 10000;
const DETAIL_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 4000;
// The local-only fast path polls ~3s; a sub-poll TTL keeps two near-simultaneous
// local ticks from double-spawning the local `agents` subprocess.
const LOCAL_CACHE_TTL_MS = 1500;
const LOAD_PROBE_TIMEOUT_MS = 4000;
// Cap on concurrent host fan-out. Offline hosts are skipped before this, so the
// online set is usually small; the cap just stops a large tailnet from spawning a
// thundering herd of ssh handshakes at once (the M5-freeze failure mode).
const FANOUT_CONCURRENCY = 4;
// SSH multiplexing for the ONE ssh we invoke directly — the CPU-load probe. The
// main session fetch runs through `agents --host`, whose SSH the CLI owns, so this
// only warms the CPU-probe connection (reused across repeated probes to the same
// host); it does not cover the session fetch.
const SSH_MUX_OPTS = [
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=~/.ssh/cm-%r@%h:%p',
  '-o', 'ControlPersist=60s',
];

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

/** Resolve `p`, or `fallback` after `ms` — guards against a child that ignores its
 *  own timeout (a hung ssh) and would otherwise block the whole fan-out forever. */
function withHardTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
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
 * unit-tested; this wrapper only does the I/O.
 */
export async function discoverHosts(): Promise<ReconciledHost[]> {
  const devices = await listRegisteredDevices();
  const inputs: RegisteredDeviceInput[] = devices.map((d) => ({
    name: d.name,
    address: d.host,
    online: d.online === true,
  }));
  return reconcileHosts(inputs, LOCAL_HOST);
}

// --- Tier-1: active fetch ---------------------------------------------------

/** Read the tail of a local session file for activity/throughput enrichment, plus
 *  the file mtime (last-write epoch ms) — the real "last activity" signal used to
 *  age out stale sessions. */
async function readSessionTail(
  sessionFile: string,
  agentType: string
): Promise<{ content: string; mtimeMs: number } | null> {
  try {
    const stat = await fs.promises.stat(sessionFile);
    const size = stat.size;
    const fh = await fs.promises.open(sessionFile, 'r');
    try {
      // Gemini is a single JSON object — must read the whole file. Claude/Codex
      // are JSONL; the last 256KB covers the rolling throughput window + latest
      // activity without re-reading multi-MB logs.
      const readStart = agentType === 'gemini' ? 0 : Math.max(0, size - 256 * 1024);
      const buf = Buffer.alloc(size - readStart);
      await fh.read(buf, 0, buf.length, readStart);
      return { content: buf.toString('utf-8'), mtimeMs: stat.mtimeMs };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Live CPU load ratio (1-min loadavg / cores) for one host. Local reads
 * os.loadavg()/os.cpus() directly (no shell-out); remote runs a single
 * `uptime; getconf _NPROCESSORS_ONLN` over the SAME ssh path the session fetch
 * uses. Returns null when the probe fails or the output can't be parsed — the
 * caller then derives load from agent count alone. Only called for reachable
 * hosts, so dead machines are never probed.
 */
async function probeCpuRatio(host: string, isLocal: boolean): Promise<number | null> {
  if (isLocal) {
    const cores = os.cpus().length;
    if (cores <= 0) return null;
    return os.loadavg()[0] / cores;
  }
  try {
    const { stdout } = await execFileAsync(
      'ssh',
      [...SSH_MUX_OPTS, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', host, 'uptime; getconf _NPROCESSORS_ONLN'],
      { timeout: LOAD_PROBE_TIMEOUT_MS, maxBuffer: 1 * 1024 * 1024, env: pathAugmentedEnv() },
    );
    return parseRemoteCpuRatio(stdout);
  } catch {
    return null;
  }
}

/** Run `agents sessions --active --json`, locally or on one remote via --host.
 *  `probeCpu` gates the second (CPU-load) SSH round-trip: the live feed poll passes
 *  false to fetch sessions with ONE connection per host; the Dispatch panel passes
 *  true when it needs fresh load for ranking. */
async function fetchActiveForHost(sshTarget: string, isLocal: boolean, hostKey: string, fetchedAt: number, probeCpu: boolean, projectRules: ProjectRule[]): Promise<{
  host: string;
  online: boolean;
  sessions: RemoteSession[];
  cpuRatio: number | null;
}> {
  const agentsBin = await findAgentsCli();
  const args = ['sessions', '--active', '--json'];
  // `sshTarget` is the machine's SSH address (Tailscale dnsName); `hostKey` is the
  // canonical device label that groups the sessions in the UI. They differ for a
  // registered device, so the --host reach and the sidebar bucket stay decoupled.
  if (!isLocal) args.push('--host', sshTarget);
  try {
    const { stdout } = await execFileAsync(agentsBin, args, {
      timeout: isLocal ? ACTIVE_TIMEOUT_LOCAL_MS : ACTIVE_TIMEOUT_REMOTE_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: pathAugmentedEnv(),
    });
    const parsed = JSON.parse(stdout);
    const raw: any[] = Array.isArray(parsed) ? parsed : [];
    const normalized = raw
      .filter((rec) => rec && typeof rec === 'object')
      .map((rec) => normalizeActiveSession(rec, hostKey, fetchedAt, projectRules));
    // Collapse the many-processes-per-session records to one card BEFORE enriching,
    // so each session file is read once (not once per duplicate pid) and the header
    // count matches what the feed renders.
    const unique = dedupeSessions(normalized);
    const sessions: RemoteSession[] = [];
    for (let session of unique) {
      // Only the local host can cheaply read session files to enrich activity,
      // throughput, and waiting. Remote hosts stay status-only until Tier-2.
      if (isLocal && session.sessionFile) {
        const tail = await readSessionTail(session.sessionFile, session.agentType);
        if (tail) {
          session = enrichWithSessionContent(session, tail.content, fetchedAt);
          // The file's last-write time is the real last-activity signal (the CLI
          // payload carries no timestamp for terminal sessions) — feed it to the
          // staleness check so an abandoned local agent ages out.
          session = { ...session, lastActivityMs: tail.mtimeMs };
        }
      }
      sessions.push(session);
    }
    // Host answered, so it is reachable. Local CPU is free (os.loadavg, no shell-out)
    // so always read it; a remote probe is a second SSH, so only when asked. Guarded
    // by its own hard timeout so a slow ssh can never extend the fan-out.
    const cpuRatio = (probeCpu || isLocal)
      ? await withHardTimeout(probeCpuRatio(sshTarget, isLocal), LOAD_PROBE_TIMEOUT_MS + 1000, null)
      : null;
    return { host: hostKey, online: true, sessions, cpuRatio };
  } catch {
    // Dead / slow / unreachable host — never throw the whole fan-out.
    return { host: hostKey, online: false, sessions: [], cpuRatio: null };
  }
}

export interface HostSessionsResult {
  hosts: HostInfo[];
  sessions: RemoteSession[];
  groups: HostGroup[];
  fetchedAt: number;
}

// Short-TTL cache + in-flight guard so the webview polling this does not launch
// overlapping SSH fan-outs (mirrors the throughputCache intent in
// settings.vscode.ts).
// `hasCpu` records whether this cached result carries live CPU load. A CPU-less feed
// result must NOT satisfy a Dispatch call that needs load for ranking, so a probeCpu
// caller treats a CPU-less cache as a miss.
// `rulesKey` records the project-rule set baked into the cached projects; a change
// to the user's rules invalidates the cache so grouping updates on the next poll.
let activeCache: { at: number; hasCpu: boolean; rulesKey: string; result: HostSessionsResult } | null = null;
let activeInFlight: Promise<HostSessionsResult> | null = null;
let localCache: { at: number; rulesKey: string; result: HostSessionsResult } | null = null;
let localInFlight: Promise<HostSessionsResult> | null = null;

export interface FetchHostSessionsOptions {
  /** Also probe each remote host's CPU load (a second SSH per host). The live feed
   *  poll leaves this false; the Dispatch panel sets it true for load ranking. */
  probeCpu?: boolean;
  /** Ordered cwd->project mappings applied when normalizing each session's project. */
  projectRules?: ProjectRule[];
}

function projectRulesKey(rules: ProjectRule[]): string {
  return JSON.stringify(rules ?? []);
}

/** A discovered host offline at discovery time (Tailscale said so) becomes an
 *  offline roster entry WITHOUT an SSH attempt — this is the single biggest cost
 *  cut, since an unreachable host otherwise hangs a process up to the full
 *  ACTIVE_TIMEOUT_REMOTE_MS on every poll. */
function offlineHostInfo(name: string): HostInfo {
  return { name, online: false, agents: 0, load: 'off', uses: 0 };
}

/**
 * Tier-1: enumerate hosts and fetch active sessions from each ONLINE host in
 * parallel (bounded by FANOUT_CONCURRENCY). Offline hosts are skipped entirely and
 * appear as empty offline roster entries. One dead host yields {online:false} with
 * no sessions instead of failing the batch. Cached for CACHE_TTL_MS; concurrent
 * callers share the in-flight promise.
 */
export async function fetchHostSessions(
  fetchedAt: number = Date.now(),
  opts: FetchHostSessionsOptions = {},
): Promise<HostSessionsResult> {
  const probeCpu = opts.probeCpu === true;
  const projectRules = opts.projectRules ?? [];
  const rulesKey = projectRulesKey(projectRules);
  if (
    activeCache &&
    fetchedAt - activeCache.at < CACHE_TTL_MS &&
    (activeCache.hasCpu || !probeCpu) &&
    activeCache.rulesKey === rulesKey
  ) {
    return activeCache.result;
  }
  if (activeInFlight) return activeInFlight;

  activeInFlight = (async () => {
    const hosts = await discoverHosts();
    // Only fan out to hosts believed reachable (device registry online flag). Offline
    // registered devices are skipped entirely and appear as empty offline roster rows.
    const online = hosts.filter((h) => h.online);
    const offline = hosts.filter((h) => !h.online);
    const onlineResults = await mapWithConcurrency(online, FANOUT_CONCURRENCY, (h) => {
      // The local machine's sessions are labelled 'this-mac' for the UI and queried
      // directly (no --host); a registered remote is reached over ssh at its address
      // but grouped under its canonical device name.
      const hostKey = h.isLocal ? LOCAL_LABEL : h.name;
      const sshTarget = h.isLocal ? hostKey : h.address;
      // execFile's own timeout sends SIGTERM, which a hung ssh can ignore (stuck
      // on connect / host-key / auth). Race every host against a hard wall-clock
      // timeout that always resolves, so ONE unreachable machine can never block
      // the batch — which was leaving the whole Floor empty.
      return withHardTimeout(
        fetchActiveForHost(sshTarget, h.isLocal, hostKey, fetchedAt, probeCpu, projectRules),
        h.isLocal ? ACTIVE_TIMEOUT_LOCAL_MS + 2000 : ACTIVE_TIMEOUT_REMOTE_MS + 2000,
        { host: hostKey, online: false, sessions: [], cpuRatio: null }
      );
    });
    // Merge every host's sessions, then (1) collapse the SAME session id reported by
    // more than one host into one — cross-host dedupe, so a session synced/reachable
    // on two machines is counted once — and (2) drop stale (long-dead) sessions. Both
    // run on the merged set so counts, the feed, and needs-you all reconcile.
    const merged: RemoteSession[] = [];
    for (const r of onlineResults) merged.push(...r.sessions);
    const sessions = filterStaleSessions(dedupeSessions(merged), fetchedAt);
    // Per-host live counts from the reconciled set (post dedupe + stale), so a host's
    // agent count matches exactly the cards the feed renders for it.
    const countByHost = new Map<string, number>();
    for (const s of sessions) countByHost.set(s.host, (countByHost.get(s.host) ?? 0) + 1);
    const resolvedHosts: HostInfo[] = onlineResults.map((r) => {
      // agents = this host's reconciled active-session count (== HostGroup.sessions.length);
      // load = derived from that plus the live CPU ratio ('off' when offline);
      // uses = the same active count, the ranking tiebreak we can source today.
      const agents = countByHost.get(r.host) ?? 0;
      const load = r.online ? deriveHostLoad(agents, r.cpuRatio) : 'off';
      return { name: r.host, online: r.online, agents, load, uses: agents };
    });
    // Keep offline registered devices visible in the roster so the sidebar lists them.
    for (const h of offline) resolvedHosts.push(offlineHostInfo(h.name));
    const groups = groupByHost(sessions, resolvedHosts, fetchedAt);
    const result: HostSessionsResult = { hosts: resolvedHosts, sessions, groups, fetchedAt };
    activeCache = { at: fetchedAt, hasCpu: probeCpu, rulesKey, result };
    return result;
  })();

  try {
    return await activeInFlight;
  } finally {
    activeInFlight = null;
  }
}

/**
 * Local-only fast path: fetch just THIS machine's sessions (no SSH, no host
 * discovery). Feeds the 3s local poll so the feed feels live without paying the
 * remote fan-out cost. Returns a single-host ('this-mac') HostSessionsResult.
 */
export async function fetchLocalSessions(
  fetchedAt: number = Date.now(),
  projectRules: ProjectRule[] = [],
): Promise<HostSessionsResult> {
  const rulesKey = projectRulesKey(projectRules);
  if (localCache && fetchedAt - localCache.at < LOCAL_CACHE_TTL_MS && localCache.rulesKey === rulesKey) {
    return localCache.result;
  }
  if (localInFlight) return localInFlight;

  localInFlight = (async () => {
    const r = await withHardTimeout(
      fetchActiveForHost(LOCAL_LABEL, true, LOCAL_LABEL, fetchedAt, false, projectRules),
      ACTIVE_TIMEOUT_LOCAL_MS + 2000,
      { host: LOCAL_LABEL, online: false, sessions: [], cpuRatio: null },
    );
    // Drop stale (long-dead) sessions here too so the fast local poll never
    // resurrects an abandoned agent the full sweep would have aged out.
    const sessions = filterStaleSessions(r.sessions, fetchedAt);
    const agents = sessions.length;
    const host: HostInfo = {
      name: LOCAL_LABEL,
      online: r.online,
      agents,
      load: r.online ? deriveHostLoad(agents, r.cpuRatio) : 'off',
      uses: agents,
    };
    const groups = groupByHost(sessions, [host], fetchedAt);
    const result: HostSessionsResult = { hosts: [host], sessions, groups, fetchedAt };
    localCache = { at: fetchedAt, rulesKey, result };
    return result;
  })();

  try {
    return await localInFlight;
  } finally {
    localInFlight = null;
  }
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
 * `agents sessions <id> --markdown --include tools`, over SSH via --host for
 * remote machines. Returns an error string rather than throwing.
 */
export async function fetchHostSessionDetail(
  host: string,
  sessionId: string
): Promise<HostSessionDetail> {
  const agentsBin = await findAgentsCli();
  const isLocal = host === LOCAL_HOST || host === LOCAL_LABEL;
  const args = ['sessions', sessionId, '--markdown', '--include', 'tools'];
  if (!isLocal) args.push('--host', host);
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
