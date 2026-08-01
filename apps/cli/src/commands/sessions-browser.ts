/**
 * Interactive fleet-wide session browser — the human front-end of `agents sessions`.
 *
 * One canonical filter state (device / agent / project / window / running / teams),
 * driven by single-key hotkeys, re-pulling live over the same fleet fan-out the flag
 * surface uses. The identical state is expressible as flags (the agent front-end);
 * `y` / `--print-cmd` round-trips a hand-built view into a copy-pasteable command.
 *
 * Built on {@link dynamicPicker}; every data source (discover, fleet, live index,
 * preview, resume dispatch) is reused from the existing sessions plumbing.
 */

import path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { dynamicPicker } from '../lib/picker.js';
import { isSessionTrackedAgent, type SessionMeta } from '../lib/session/types.js';
import type { ActiveSession } from '../lib/session/active.js';
import { discoverSessions } from '../lib/session/discover.js';
import { gatherRemoteList } from '../lib/session/remote-list.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { buildPreview } from './sessions-picker.js';
import {
  formatPickerLabel,
  pickerColumnsFor,
  type SshOriginTag,
  ticketLabel,
  mergeLocalFirst,
  gatherActiveSessions,
  liveHostLabel,
  LIVE_ROW_PREFIX,
  cleanPreview,
  handlePickedSession,
  shouldIncludeLocal,
  remoteHostsToDial,
  type PickerColumns,
} from './sessions.js';

/**
 * The single canonical filter state. Every field has a flag equivalent, so the
 * same view is reachable interactively (hotkeys) or from the command line (flags).
 */
export interface BrowserFilter {
  /** running-only — the `R` key / `--active`. */
  running: boolean;
  /** include team-spawned sessions — the `C` key / `--teams`. */
  teams: boolean;
  /** filter to one agent, or all — the `A` key / `-a`. */
  agent?: string;
  /** filter to one machine, or all — the `D` key / `--device`. */
  device?: string;
  /** this-repo subtree vs every directory — the `P` key / `--all`. */
  projectScope: 'repo' | 'all';
  /** time window (undefined = all time) — the `W` key / `--since`. */
  window?: string;
}

/** Ordered window cycle for the `W` key. `undefined` = all time. */
const WINDOW_CYCLE: (string | undefined)[] = [undefined, '1d', '7d', '30d'];

/** Return the next value in `[undefined, ...options]`, wrapping. */
export function cycle(current: string | undefined, options: string[]): string | undefined {
  const ring = [undefined, ...options];
  const idx = ring.findIndex((v) => v === current);
  return ring[(idx + 1) % ring.length];
}

export function cycleWindow(current: string | undefined): string | undefined {
  const idx = WINDOW_CYCLE.findIndex((v) => v === current);
  return WINDOW_CYCLE[(idx + 1) % WINDOW_CYCLE.length];
}

function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort();
}

/**
 * Cheap client-side match for the `S` search — a plain substring test over a
 * row's visible fields. Deliberately NOT the FTS `filterSessionsByQuery`: that
 * runs a content-index scan per call, which is fine once over a pool but a
 * CPU sink when a picker calls it per-row on every keystroke.
 */
export function sessionMatchesQuery(s: SessionMeta, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [
    s.shortId,
    s.agent,
    s.project,
    s.cwd,
    s.topic,
    (s as { label?: string }).label,
    ticketLabel(s),
    s.machine,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * The canonical `ag sessions …` command for a filter state (+ optional search) —
 * the agent-facing twin of the interactive view. Shared by the `y` hotkey and
 * `--print-cmd`.
 */
export function browserFilterToArgv(f: BrowserFilter, query = ''): string[] {
  const a = ['sessions'];
  if (f.running) a.push('--active');
  if (f.teams) a.push('--teams');
  if (f.agent) a.push('-a', f.agent);
  if (f.device) a.push('--device', f.device);
  if (f.projectScope === 'all') a.push('--all');
  if (f.window) a.push('--since', f.window);
  const q = query.trim();
  if (q) a.push(JSON.stringify(q));
  return a;
}

/** Normalize a `--host`/`--device` token (`alias`, `user@host`, `host.domain`) to
 * the canonical machine id the rows carry in `.machine`, so a flag seed matches
 * (the `d` hotkey already cycles canonical ids). Mirrors sessions.ts `hostToken`. */
export function normalizeDeviceSeed(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return normalizeHost(host.split('@').pop() || host);
}

/**
 * The initial filter for the `--active` browser: fleet-wide (matches the static
 * `renderActiveSessions`, which has no project scoping — the `p` hotkey narrows to
 * this repo), running-only, with the device seed normalized and `--since` seeding
 * the window. Pure, so the routing call site is unit-testable.
 */
export function activeBrowserSeed(opts: {
  teams?: boolean;
  agent?: string;
  host?: string[];
  since?: string;
  all?: boolean;
}): Partial<BrowserFilter> {
  return {
    running: true,
    teams: !!opts.teams,
    agent: opts.agent,
    projectScope: 'all',
    device: normalizeDeviceSeed(opts.host?.[0]),
    // --all widens the window to all-time (project is already 'all' here);
    // --since still overrides.
    window: opts.since ?? (opts.all ? undefined : '30d'),
  };
}

/**
 * The initial filter for the bare interactive listing: current-repo subtree by
 * default (matches the static overview's cwd scoping). `--all` sets every
 * non-status filter to its "all" value — every directory (project) AND all-time
 * (window) — so one flag maxes the view; `--since` still overrides the window and
 * `-a`/`--device` still narrow their axis.
 */
export function bareBrowserSeed(opts: {
  teams?: boolean;
  agent?: string;
  all?: boolean;
  since?: string;
}): Partial<BrowserFilter> {
  return {
    teams: !!opts.teams,
    agent: opts.agent,
    // --all maxes every non-status filter: all dirs AND all-time. --since wins.
    projectScope: opts.all ? 'all' : 'repo',
    window: opts.since ?? (opts.all ? undefined : '30d'),
  };
}

/** Copy text to the OS clipboard (best-effort; silently no-ops if unavailable). */
function copyToClipboard(text: string): boolean {
  const candidates =
    process.platform === 'darwin'
      ? [['pbcopy', [] as string[]]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ];
  for (const [cmd, args] of candidates as [string, string[]][]) {
    try {
      const res = spawnSync(cmd, args, { input: text });
      if (res.status === 0) return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/** The transcript pool: the local index + (unless --local) a live fleet fan-out.
 * The live index is fetched separately/lazily — it's the slow part and only the
 * running filter needs it, so a bare browse stays instant.
 *
 * `hosts` is the explicit `--host`/`--device` scope (if any): it restricts which
 * peers are dialed and whether local is included, honoring the flag's "scope,
 * not add" contract instead of always sweeping the whole fleet. */
async function fetchRawPool(
  f: BrowserFilter,
  self: string,
  local: boolean,
  hosts: string[] | undefined,
): Promise<{ key: string; rows: SessionMeta[] }> {
  const since = f.window;
  // Local pool: wide (every directory) — device/agent/project are applied in
  // memory so a hotkey toggle is instant and doesn't re-hit the disk. Skipped
  // when an explicit host scope excludes this machine.
  let rows: SessionMeta[] = shouldIncludeLocal(hosts, self)
    ? await discoverSessions({
        all: true,
        cwd: process.cwd(),
        since,
        excludeTeamOrigin: !f.teams,
        limit: 500,
        sortBy: 'timestamp',
      })
    : [];

  // Fleet: fold in peers' own indexes over SSH (no sync), same as the flag path.
  // Skipped under --local. An explicit --host/--device scopes exactly which peers
  // are dialed (undefined = sweep every online device). Best-effort — a fan-out
  // failure leaves the local list intact.
  if (!local) {
    try {
      const forwarded = ['sessions', '--all', '--json', '--limit', '500'];
      if (since) forwarded.push('--since', since);
      if (f.teams) forwarded.push('--teams');
      const { sessions: remote } = await gatherRemoteList(forwarded, remoteHostsToDial(hosts, self));
      if (remote.length > 0) rows = mergeLocalFirst([...rows, ...remote], self);
    } catch {
      // enrichment, never a hard dependency
    }
  }

  return { key: `${since ?? 'all'}|${f.teams}`, rows };
}

/**
 * A live session's stable row key: its session id when the agent reported one,
 * else a per-machine handle so an id-less live session (a just-booted harness, a
 * cloud task) still gets exactly one row instead of being dropped. Cloud rows key
 * on the task id because they have no pid — keying them all on the machine alone
 * would collapse two cloud tasks into one row, the same silent-drop this whole
 * change exists to remove.
 */
export function liveRowKey(a: ActiveSession, self: string): string {
  if (a.sessionId) return a.sessionId;
  const handle = a.cloudTaskId ?? (a.pid != null ? String(a.pid) : 'unknown');
  return `${LIVE_ROW_PREFIX}${a.machine ?? self}:${handle}`;
}

/** Index live sessions by {@link liveRowKey} — the join key between the live scan
 *  and the transcript pool. Id-carrying rows key on the session id, so a live row
 *  and its transcript row collapse to one. */
export function indexLiveRows(rows: ActiveSession[], self: string): Map<string, ActiveSession> {
  const byKey = new Map<string, ActiveSession>();
  for (const a of rows) byKey.set(liveRowKey(a, self), a);
  return byKey;
}

/**
 * Project a live session onto the picker's row shape, for a session the transcript
 * pool doesn't carry — a peer's session, a transcript outside the current window,
 * or an agent that has not written one yet. `filePath` is the live transcript path
 * when the scan resolved one and empty otherwise, which is what
 * {@link handlePickedSession} keys "there is nothing to open yet" off.
 */
export function liveSessionToMeta(a: ActiveSession, self: string): SessionMeta {
  const machine = a.machine ?? self;
  const started = a.startedAtMs ?? a.lastActivityMs;
  const topic = a.topic ?? a.preview;
  return {
    id: liveRowKey(a, self),
    // No session id to short — name the row by what it IS (a cloud task, a pid),
    // so the id column still identifies the process you'd go looking for.
    shortId: a.sessionId
      ? a.sessionId.slice(0, 8)
      : a.cloudTaskId
        ? a.cloudTaskId.slice(0, 8)
        : `p:${a.pid ?? '?'}`,
    agent: isSessionTrackedAgent(a.kind) ? a.kind : 'claude',
    timestamp: new Date(started ?? Date.now()).toISOString(),
    lastActivity: a.lastActivityMs ? new Date(a.lastActivityMs).toISOString() : undefined,
    project: a.cwd ? path.basename(a.cwd) : undefined,
    cwd: a.cwd,
    filePath: a.sessionFile ?? '',
    // A live topic is raw transcript text: a newline in it would break the row
    // into two and misalign every column after it. Indexed rows are already
    // cleaned at scan time, so this puts projected rows on the same footing.
    topic: topic ? cleanPreview(topic) : undefined,
    label: a.label ? cleanPreview(a.label) : undefined,
    machine,
    // Reading/resuming a peer's session hops back over SSH — same contract the
    // cross-machine listing sets, so handlePickedSession routes it correctly.
    _remote: machine !== self,
    prUrl: a.pr?.url,
    prNumber: a.pr?.number,
    ticketId: a.ticket?.id,
    worktreeSlug: a.worktree?.slug,
  };
}

/**
 * Fold the live scan INTO the transcript pool. The running filter used to be a
 * pure intersection (`pool ∩ live`), which meant a session had to already be in
 * the pool to be shown as running — so every session on another machine, and
 * every local one outside the pool's window, was invisible in the browser while
 * `--active --json` listed it. Live sessions the pool lacks are appended as their
 * own rows, then the whole set is grouped local-machine-first.
 */
export function mergeLiveIntoPool(
  rows: SessionMeta[],
  live: Map<string, ActiveSession>,
  self: string,
): SessionMeta[] {
  const known = new Set(rows.map((r) => r.id));
  const extra: SessionMeta[] = [];
  for (const [key, a] of live) {
    if (!known.has(key)) extra.push(liveSessionToMeta(a, self));
  }
  return extra.length === 0 ? rows : mergeLocalFirst([...rows, ...extra], self);
}

/**
 * Whether to render the host-program column. It belongs to the running view
 * only, so this gates on the FILTER — not on the live index being populated.
 * `liveCache` outlives a toggle of the `r` hotkey, so testing `live` alone would
 * keep the column after running is turned back off, widening a plain transcript
 * listing that has no live rows to explain it.
 */
export function shouldShowHostColumn(
  f: BrowserFilter,
  live: Map<string, ActiveSession> | null,
  rows: SessionMeta[],
): boolean {
  if (!f.running || !live) return false;
  return rows.some((r) => liveHostLabel(live.get(r.id)) !== '');
}

/** Apply the cheap in-memory filters (agent / device / project / running). */
function applyFilters(
  rows: SessionMeta[],
  live: Map<string, ActiveSession>,
  f: BrowserFilter,
  self: string,
): SessionMeta[] {
  let out = rows;
  if (f.agent) out = out.filter((r) => r.agent === f.agent);
  if (f.device) out = out.filter((r) => (r.machine ?? self) === f.device);
  if (f.projectScope === 'repo') {
    const cwd = process.cwd();
    out = out.filter((r) => !!r.cwd && (r.cwd === cwd || r.cwd.startsWith(cwd + '/')));
  }
  if (f.running) out = out.filter((r) => live.has(r.id));
  return out;
}

/** Derive the SSH-launch origin tag for a picker row from the live index. Set
 * only when the live session's provenance is ssh transport; `device` is the
 * resolved origin device (absent → the row shows a bare `ssh`). Rows without a
 * live entry (the running filter off) get no tag — provenance is live-only. */
function sshOriginTagFor(live: Map<string, ActiveSession> | null, id: string): SshOriginTag | undefined {
  const p = live?.get(id)?.provenance;
  if (p?.transport !== 'ssh') return undefined;
  return p.origin?.device ? { device: p.origin.device } : {};
}

function headerFor(f: BrowserFilter): string {
  const bits = [
    `device:${f.device ?? 'all'}`,
    `agent:${f.agent ?? 'all'}`,
    f.projectScope === 'repo' ? 'this repo' : 'all dirs',
    `window:${f.window ?? 'all'}`,
  ];
  if (f.running) bits.push('running');
  if (f.teams) bits.push('teams');
  return bits.join(' · ');
}

function helpFor(_f: BrowserFilter, mode: 'nav' | 'search'): string {
  if (mode === 'search') {
    return 'type to filter · ↑↓ navigate · esc exit search · ⏎ resume';
  }
  return 's search · r running · c teams · a agent · d device · p project · w window · tab preview · y copy-cmd · ⏎ resume · esc quit';
}

/**
 * Launch the interactive session browser. `initial` seeds the filter (e.g.
 * `{ running: true }` for `--active`). Resolves after the user resumes a session
 * or cancels — the picked row is dispatched through the shared resume/focus path.
 */
export async function runSessionBrowser(
  initial: Partial<BrowserFilter> = {},
  opts: { local?: boolean; hosts?: string[] } = {},
): Promise<void> {
  const self = machineId();
  const local = opts.local ?? false;
  const hosts = opts.hosts && opts.hosts.length > 0 ? opts.hosts : undefined;

  // Updated after each load so the A/D cycles range over what's actually present.
  let agentsInPool: string[] = [];
  let devicesInPool: string[] = [];
  let cols: PickerColumns = {};
  // Cache the transcript fetch, keyed by (window, teams); agent/device/project/
  // running are applied in memory so their hotkeys don't re-fan-out the fleet.
  let rawCache: { key: string; rows: SessionMeta[] } | null = null;
  // The live index is slow (a full ps/tmux scan) and only the running filter
  // needs it — fetch it once, lazily, the first time running is toggled on.
  let liveCache: Map<string, ActiveSession> | null = null;
  // Generation guard: two quick keypresses can start overlapping loads whose
  // SSH fan-outs settle out of order. dynamicPicker's own gen ref guards which
  // rows become `items`, but the shared closure state below (cols / cycle pools /
  // caches) is a side channel it can't see — so a stale load must never commit
  // it. We compute into locals and only write the shared state as the latest load.
  let loadGen = 0;

  const initialFilter: BrowserFilter = {
    running: initial.running ?? false,
    teams: initial.teams ?? false,
    agent: initial.agent,
    device: initial.device,
    projectScope: initial.projectScope ?? 'repo',
    window: 'window' in initial ? initial.window : '30d',
  };

  const load = async (f: BrowserFilter): Promise<SessionMeta[]> => {
    const myGen = ++loadGen;
    const key = `${f.window ?? 'all'}|${f.teams}`;
    let pool = rawCache && rawCache.key === key ? rawCache : null;
    if (!pool) {
      const fetched = await fetchRawPool(f, self, local, hosts);
      if (myGen !== loadGen) return []; // superseded — don't touch shared state
      pool = fetched;
    }
    // Only pay for the live scan when the running filter needs it. Same fleet
    // sweep the static `--active` view uses, so the two never disagree about
    // what is running.
    let live = liveCache;
    if (f.running && !live) {
      try {
        const { sessions } = await gatherActiveSessions({ local, hosts });
        live = indexLiveRows(sessions, self);
      } catch {
        live = new Map();
      }
      if (myGen !== loadGen) return [];
    }
    // Latest load — commit shared state atomically (no await past this point, so
    // no newer load can interleave between these writes).
    rawCache = pool;
    if (live) liveCache = live;
    // Live sessions the transcript pool lacks become rows of their own, so the
    // running view lists every active session, not just the ones already indexed.
    const rows = f.running && live ? mergeLiveIntoPool(pool.rows, live, self) : pool.rows;
    agentsInPool = distinct(rows.map((r) => r.agent));
    devicesInPool = distinct(rows.map((r) => r.machine ?? self));
    const filtered = applyFilters(rows, live ?? new Map(), f, self);
    cols = pickerColumnsFor(filtered);
    cols.showHost = shouldShowHostColumn(f, live, filtered);
    return filtered;
  };

  const picked = await dynamicPicker<SessionMeta, BrowserFilter>({
    message: 'Sessions',
    initialFilter,
    load,
    keyFor: (s) => s.id,
    labelFor: (s, q) =>
      formatPickerLabel(s, q, cols, sshOriginTagFor(liveCache, s.id), liveHostLabel(liveCache?.get(s.id))),
    matches: sessionMatchesQuery,
    buildPreview,
    headerFor,
    helpFor,
    enterHint: 'resume',
    emptyMessage: 'No sessions match this filter.',
    loadingMessage: local ? 'Loading…' : 'Loading (reaching other machines)…',
    keyBindings: {
      r: (f) => ({ ...f, running: !f.running }),
      c: (f) => ({ ...f, teams: !f.teams }),
      a: (f) => ({ ...f, agent: cycle(f.agent, agentsInPool) }),
      d: (f) => ({ ...f, device: cycle(f.device, devicesInPool) }),
      p: (f) => ({ ...f, projectScope: f.projectScope === 'repo' ? 'all' : 'repo' }),
      w: (f) => ({ ...f, window: cycleWindow(f.window) }),
    },
    onKey: (name, f, _active, query) => {
      if (name === 'y') {
        // Thread the live search query so the copied command reproduces the
        // exact view — the human→agent bridge must include the search term.
        const cmd = 'ag ' + browserFilterToArgv(f, query).join(' ');
        const ok = copyToClipboard(cmd);
        return ok ? `copied: ${cmd}` : cmd;
      }
      return undefined;
    },
  });

  if (!picked) return;
  await handlePickedSession({ session: picked.item, action: 'resume' });
}
