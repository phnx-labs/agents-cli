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

import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { dynamicPicker } from '../lib/picker.js';
import type { SessionMeta } from '../lib/session/types.js';
import { getActiveSessions, type ActiveSession } from '../lib/session/active.js';
import { discoverSessions } from '../lib/session/discover.js';
import { gatherRemoteList } from '../lib/session/remote-list.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { buildPreview } from './sessions-picker.js';
import {
  formatPickerLabel,
  pickerColumnsFor,
  ticketLabel,
  mergeLocalFirst,
  indexActiveBySessionId,
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
}): Partial<BrowserFilter> {
  return {
    running: true,
    teams: !!opts.teams,
    agent: opts.agent,
    projectScope: 'all',
    device: normalizeDeviceSeed(opts.host?.[0]),
    window: opts.since ?? '30d',
  };
}

/**
 * The initial filter for the bare interactive listing: current-repo subtree by
 * default (matches the static overview's cwd scoping), `--all` widens to every
 * directory, `--since` seeds the window.
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
    projectScope: opts.all ? 'all' : 'repo',
    window: opts.since ?? '30d',
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
  return 's search · r running · c teams · a agent · d device · p project · w window · y copy-cmd · ⏎ resume · esc quit';
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
    // Only pay for the live scan when the running filter needs it.
    let live = liveCache;
    if (f.running && !live) {
      try {
        live = indexActiveBySessionId(await getActiveSessions());
      } catch {
        live = new Map();
      }
      if (myGen !== loadGen) return [];
    }
    // Latest load — commit shared state atomically (no await past this point, so
    // no newer load can interleave between these writes).
    rawCache = pool;
    if (live) liveCache = live;
    agentsInPool = distinct(pool.rows.map((r) => r.agent));
    devicesInPool = distinct(pool.rows.map((r) => r.machine ?? self));
    const filtered = applyFilters(pool.rows, live ?? new Map(), f, self);
    cols = pickerColumnsFor(filtered);
    return filtered;
  };

  const picked = await dynamicPicker<SessionMeta, BrowserFilter>({
    message: 'Sessions',
    initialFilter,
    load,
    keyFor: (s) => s.id,
    labelFor: (s, q) => formatPickerLabel(s, q, cols),
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
