/**
 * Read-only view of the SessionStart hook's live-session state files.
 *
 * The `@agents/session-tracker` hook (installed into each agent's own config)
 * writes `~/.agents/.cache/terminals/sessions/<pid>.json` AFTER an agent boots,
 * carrying the agent's OWN authoritative session id (from its SessionStart
 * payload) plus the join keys `launch_id` / `terminal_id`. It is the only writer
 * that sees agents `ag run` did NOT launch (you typing `claude` in a terminal),
 * and the only source of an exact id for non-Claude agents (whose id we can't
 * know at spawn).
 *
 * This module lets `sessions --active` reconcile a `ps`-discovered pid to that
 * authoritative id. It is deliberately a small hand-rolled reader — the CLI does
 * NOT import the session-tracker package (a separate, workspace-less package;
 * see packages/session-tracker/CLAUDE.md) — mirroring the Factory extension's own
 * hand-copied reader in apps/factory/src/core/liveSession.ts. It only READS the
 * existing dir/schema; it never writes or moves anything, so it is safe across a
 * fleet where old hooks and a new CLI coexist.
 *
 * The whole state dir is scanned ONCE per active-scan into an index (the listing
 * path polls every ~3s), and every lookup keys the pre-built maps — never a
 * re-scan per candidate.
 */
import fs from 'fs';
import path from 'path';
import { getTerminalsDir } from '../state.js';

/** The subset of the hook's on-disk record this reader relies on. Extra fields are ignored. */
export interface HookSessionRecord {
  session_id: string;
  agent?: string;
  cwd?: string;
  pid: number;
  launch_id?: string;
  terminal_id?: string;
  ts?: number;
}

/** Pre-built lookup maps over one scan of the hook state dir. */
export interface HookSessionIndex {
  byLaunchId: Map<string, HookSessionRecord>;
  byTerminalId: Map<string, HookSessionRecord>;
  byPid: Map<number, HookSessionRecord>;
}

function hookSessionsDir(): string {
  // Sibling of the pid-registry's by-pid/ dir. The hook hardcodes this same path
  // (packages/session-tracker/src/hook.sh); we read it, never move it.
  return path.join(getTerminalsDir(), 'sessions');
}

function parseRecord(raw: string): HookSessionRecord | undefined {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && typeof o.session_id === 'string' && o.session_id) {
      return o as HookSessionRecord;
    }
  } catch {
    /* unparseable — treat as absent */
  }
  return undefined;
}

/** Keep the newest record (by `ts`) when two collide on the same key. */
function keepNewest(map: Map<string | number, HookSessionRecord>, key: string | number, rec: HookSessionRecord): void {
  const prev = map.get(key);
  if (!prev || (rec.ts ?? 0) >= (prev.ts ?? 0)) map.set(key, rec);
}

/**
 * Scan the hook state dir once and index every record by launch_id, terminal_id,
 * and pid. Returns empty maps if the dir is absent. Newest-by-`ts` wins a key
 * collision (pid reuse, or a launch id lingering from a since-dead process).
 */
export function loadHookSessionIndex(): HookSessionIndex {
  const byLaunchId = new Map<string, HookSessionRecord>();
  const byTerminalId = new Map<string, HookSessionRecord>();
  const byPid = new Map<number, HookSessionRecord>();
  let files: string[];
  try {
    files = fs.readdirSync(hookSessionsDir()).filter(f => f.endsWith('.json'));
  } catch {
    return { byLaunchId, byTerminalId, byPid };
  }
  for (const f of files) {
    let rec: HookSessionRecord | undefined;
    try {
      rec = parseRecord(fs.readFileSync(path.join(hookSessionsDir(), f), 'utf8'));
    } catch {
      /* raced with the hook / pruner — skip */
    }
    if (!rec) continue;
    if (typeof rec.pid === 'number') keepNewest(byPid as Map<string | number, HookSessionRecord>, rec.pid, rec);
    if (rec.launch_id) keepNewest(byLaunchId as Map<string | number, HookSessionRecord>, rec.launch_id, rec);
    if (rec.terminal_id) keepNewest(byTerminalId as Map<string | number, HookSessionRecord>, rec.terminal_id, rec);
  }
  return { byLaunchId, byTerminalId, byPid };
}

/**
 * True if a hook record's `agent` is compatible with a `ps`-detected kind. Guards
 * the weak pid/children lookups against a STALE file at a reused pid (a dead
 * hooked agent's `<pid>.json` inherited by a live hookless agent at the same pid).
 * Permissive when the record's agent is absent/legacy-`unknown` (never reject on
 * missing metadata). Normalizes the one known naming gap: `ps` reports Cursor as
 * `cursor-agent`, the hook records it as `cursor`.
 */
function kindMatches(recordAgent: string | undefined, kind: string): boolean {
  if (!recordAgent || recordAgent === 'unknown') return true;
  const norm = (k: string) => (k === 'cursor-agent' ? 'cursor' : k);
  return norm(recordAgent) === norm(kind);
}

export interface ResolveOpts {
  pid: number;
  kind: string;
  launchId?: string;
  terminalId?: string;
  /** Immediate child pids of `pid` — the hook records under the agent pid, which
   *  for a wrapper/shell pid we recorded is a child. */
  childPids?: number[];
}

/**
 * Resolve an agent's OWN authoritative session id from the hook index. Priority
 * mirrors the session-tracker's getLiveSession: launchId join (survives pid
 * divergence — the hook runs under the agent pid, our registry entry may sit on a
 * tmux pane leaf or cmd.exe wrapper) → terminalId join → direct pid → children.
 * Every hit is kind-guarded so a stale file at a reused pid can't cross agents.
 * Undefined until the hook lands (it can lag the spawn) or for hookless harnesses.
 */
export function resolveHookSessionId(index: HookSessionIndex, opts: ResolveOpts): string | undefined {
  const { pid, kind, launchId, terminalId, childPids } = opts;
  const take = (rec: HookSessionRecord | undefined): string | undefined =>
    rec?.session_id && kindMatches(rec.agent, kind) ? rec.session_id : undefined;

  if (launchId) {
    const hit = take(index.byLaunchId.get(launchId));
    if (hit) return hit;
  }
  if (terminalId) {
    const hit = take(index.byTerminalId.get(terminalId));
    if (hit) return hit;
  }
  const direct = take(index.byPid.get(pid));
  if (direct) return direct;
  for (const c of childPids ?? []) {
    const hit = take(index.byPid.get(c));
    if (hit) return hit;
  }
  return undefined;
}
