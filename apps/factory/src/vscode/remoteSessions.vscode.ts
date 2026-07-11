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
  normalizeRecentSession,
  resolveSessionHost,
  normalizeHost,
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
/** This machine's normalized device id (machineId() form), used to recognize the
 *  CLI's own `machine` tag on local rows and fold them back to LOCAL_LABEL. */
export const LOCAL_MACHINE_ID = normalizeHost(LOCAL_HOST);

const ACTIVE_TIMEOUT_LOCAL_MS = 6000;
const ACTIVE_TIMEOUT_REMOTE_MS = 10000;
// The bare fan-out is the CLI's OWN cross-machine sweep (its per-host budget is
// ~12s, run in parallel), so it needs a wider ceiling than a single local read.
const FANOUT_TIMEOUT_MS = 15000;
const DETAIL_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 4000;
// The local-only fast path polls ~3s; a sub-poll TTL keeps two near-simultaneous
// local ticks from double-spawning the local `agents` subprocess.
const LOCAL_CACHE_TTL_MS = 1500;
const LOAD_PROBE_TIMEOUT_MS = 4000;
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

/** Run `agents sessions --active --json` in one of three modes:
 *   - fanOut  : bare call — the CLI does its OWN cross-machine SSH sweep and
 *               returns every reachable machine's sessions, each tagged with its
 *               `machine` id. This is the reliable multi-host source (the extension's
 *               own per-host `--host` sweep is unreliable ssh-in-ssh and slow).
 *   - --local : this machine's sessions only, no SSH (the cheap fast-tier poll).
 *   - --host  : one specific remote — retained for completeness, but NO current
 *               caller takes this path (both the feed sweep and the fast tier query
 *               the local machine; on-demand remote detail uses fetchHostSessionDetail).
 *  `probeCpu` only affects local CPU freshness now (both callers are local). */
async function fetchActiveForHost(sshTarget: string, isLocal: boolean, hostKey: string, fetchedAt: number, probeCpu: boolean, projectRules: ProjectRule[], fanOut = false): Promise<{
  host: string;
  online: boolean;
  sessions: RemoteSession[];
  cpuRatio: number | null;
}> {
  const agentsBin = await findAgentsCli();
  const args = ['sessions', '--active', '--json'];
  // `sshTarget` is the machine's SSH address (Tailscale dnsName); `hostKey` is the
  // canonical device label used as the fallback bucket for machine-less (cloud) rows.
  if (fanOut) {
    // Bare — let the CLI fan out over the fleet; rows self-identify via `machine`.
  } else if (isLocal) {
    // Scope to this machine so the fast tier stays cheap (no SSH) and can't
    // re-pollute the this-mac bucket with stale fleet rows.
    args.push('--local');
  } else {
    args.push('--host', sshTarget);
  }
  try {
    const { stdout } = await execFileAsync(agentsBin, args, {
      timeout: fanOut ? FANOUT_TIMEOUT_MS : (isLocal ? ACTIVE_TIMEOUT_LOCAL_MS : ACTIVE_TIMEOUT_REMOTE_MS),
      maxBuffer: 16 * 1024 * 1024,
      env: pathAugmentedEnv(),
    });
    const parsed = JSON.parse(stdout);
    const raw: any[] = Array.isArray(parsed) ? parsed : [];
    const normalized = raw
      .filter((rec) => rec && typeof rec === 'object')
      // Attribute each row to the machine the CLI says it runs on (rec.machine),
      // NOT the host we queried — a --host fetch returns the queried remote's
      // sessions AND this machine's local ones, so keying on hostKey would
      // mislabel the local rows. resolveSessionHost folds our own machine id
      // back to LOCAL_LABEL and falls back to hostKey for machine-less (cloud) rows.
      .map((rec) => normalizeActiveSession(
        rec,
        resolveSessionHost(rec.machine, hostKey, LOCAL_MACHINE_ID, LOCAL_LABEL),
        fetchedAt,
        projectRules,
      ));
    // Collapse the many-processes-per-session records to one card BEFORE enriching,
    // so each session file is read once (not once per duplicate pid) and the header
    // count matches what the feed renders.
    const unique = dedupeSessions(normalized);
    const sessions: RemoteSession[] = [];
    for (let session of unique) {
      // Only THIS machine's own sessions have a readable local session file to
      // enrich activity/throughput/waiting. In fanOut mode the payload is
      // multi-machine, so gate on the resolved bucket, not the query mode —
      // remote rows stay status-only (their file lives on another host).
      if (session.host === LOCAL_LABEL && session.sessionFile) {
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

/**
 * Recent (historical, non-active) sessions for one host — what the Floor shows when a
 * host filter has 0 live agents instead of a blank pane. Uses the clean-array
 * `agents sessions --json [--host <t>] --limit N` path (flat SessionMeta), normalized
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
  else args.push('--host', sshTarget);
  try {
    const { stdout } = await execFileAsync(agentsBin, args, {
      timeout: isLocal ? ACTIVE_TIMEOUT_LOCAL_MS : ACTIVE_TIMEOUT_REMOTE_MS,
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
    // An older agents-cli (before the clean `--host --json` array) streams a
    // non-JSON banner, so JSON.parse throws -> no recent shown. Graceful: the RECENT
    // section simply stays empty until the engine change is released.
    return [];
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
): Promise<RemoteSession[]> {
  const hosts = await discoverHosts();
  const targets = hosts.filter((h) => h.isLocal || h.online);
  const results = await Promise.allSettled(
    targets.map((h) => fetchRecentForHost(h.isLocal ? LOCAL_LABEL : h.address, h.isLocal, h.name, limitPerHost, projectRules)),
  );
  const sessions = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return sessions.sort((a, b) => (b.lastActivityMs || b.startedAtMs) - (a.lastActivityMs || a.startedAtMs));
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
  /** Kept for the Dispatch panel's load-ranking call. Since the feed now sources
   *  every host from one bare fan-out (no per-host SSH), remote CPU is no longer
   *  probed; this only affects local CPU freshness + the `hasCpu` cache key so a
   *  Dispatch call after a feed poll can force one fresh sweep. */
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
 * Tier-1: fetch active sessions across the whole fleet via ONE bare fan-out (the
 * CLI's own cross-machine sweep), then reconcile against the device registry so
 * every registered host — online or idle — appears under its canonical name with
 * an accurate count. Cached for CACHE_TTL_MS; concurrent callers share the
 * in-flight promise.
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
    // ONE bare fan-out: the CLI runs its own cross-machine SSH sweep and returns
    // every reachable machine's sessions, each self-identifying via `machine`.
    // This replaces the extension's per-host `--host` sweep, which is unreliable
    // (ssh-in-ssh that reports "unreachable — skipped") and slow (~12s/host) — the
    // exact reason remote hosts were showing 0 while the fleet's work ran on them.
    const fan = await withHardTimeout(
      fetchActiveForHost(LOCAL_LABEL, true, LOCAL_LABEL, fetchedAt, probeCpu, projectRules, true),
      FANOUT_TIMEOUT_MS + 2000,
      { host: LOCAL_LABEL, online: false, sessions: [], cpuRatio: null },
    );
    // Dedupe (many pids -> one session) + drop stale, so counts, the feed, and
    // needs-you all reconcile against the same reconciled set.
    const sessions = filterStaleSessions(dedupeSessions(fan.sessions), fetchedAt);
    // Per-host live counts from the reconciled set (keyed by the machine bucket
    // resolveSessionHost assigned), so a host's count matches its rendered cards.
    const countByHost = new Map<string, number>();
    for (const s of sessions) countByHost.set(s.host, (countByHost.get(s.host) ?? 0) + 1);
    // Roster = the registered device fleet + this machine. A host is online if the
    // registry says so OR it returned live sessions; offline registered devices stay
    // visible with 0. Local CPU is free (os.loadavg); remote load derives from count.
    const resolvedHosts: HostInfo[] = [];
    const seen = new Set<string>();
    for (const h of hosts) {
      const key = h.isLocal ? LOCAL_LABEL : normalizeHost(h.name);
      seen.add(key);
      const agents = countByHost.get(key) ?? 0;
      const isOnline = h.isLocal ? fan.online : (h.online || agents > 0);
      if (!isOnline) { resolvedHosts.push(offlineHostInfo(key)); continue; }
      const load = deriveHostLoad(agents, h.isLocal ? fan.cpuRatio : null);
      resolvedHosts.push({ name: key, online: true, agents, load, uses: agents });
    }
    // Defensive: a machine that returned sessions but isn't in the device registry
    // still gets a roster row so its cards aren't orphaned from the sidebar.
    for (const [key, agents] of countByHost) {
      if (seen.has(key)) continue;
      resolvedHosts.push({ name: key, online: true, agents, load: deriveHostLoad(agents, null), uses: agents });
    }
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
