/**
 * Join a Factory tab to a CLI-authoritative session id via AGENT_TERMINAL_ID.
 *
 * The CLI surfaces `terminalId` on `agents sessions --active --json` when the
 * launch inherited AGENT_TERMINAL_ID (Factory stamps it on every agent tab and
 * forwards it across `--host`/`--device`). That is the one key that survives an
 * SSH hop and a /clear — not cwd, not newest transcript file.
 */

import { canonicalSessionId } from './canonicalSessionId';

/** Minimal active-session row shape used for the join (CLI + RemoteSession). */
export interface ActiveSessionJoinRow {
  sessionId?: string | null;
  terminalId?: string | null;
  /** Some producers put the tab id under a snake_case key. */
  terminal_id?: string | null;
}

/**
 * Build terminalId → canonical sessionId from an `--active` payload.
 * Later rows with the same terminalId win only when they carry a non-empty id
 * (keeps the map stable if a stale empty row appears after a real one).
 */
export function terminalIdToSessionIdMap(
  rows: ActiveSessionJoinRow[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const tid = (row.terminalId || row.terminal_id || '').trim();
    if (!tid) continue;
    const sid = canonicalSessionId(row.sessionId ?? undefined);
    if (!sid) continue;
    map.set(tid, sid);
  }
  return map;
}

/** Look up one tab's session id. Undefined when the feed has no row for that tab. */
export function sessionIdForTerminalId(
  rows: ActiveSessionJoinRow[],
  terminalId: string | undefined | null,
): string | undefined {
  const tid = terminalId?.trim();
  if (!tid) return undefined;
  return terminalIdToSessionIdMap(rows).get(tid);
}

/**
 * Parse the raw stdout of `agents sessions --active --json` into join rows.
 * Tolerates a non-array envelope; never throws on malformed JSON.
 */
export function parseActiveSessionJoinRows(stdout: string): ActiveSessionJoinRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ActiveSessionJoinRow[] = [];
  for (const rec of parsed) {
    if (!rec || typeof rec !== 'object') continue;
    const o = rec as Record<string, unknown>;
    out.push({
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
      terminalId: typeof o.terminalId === 'string' ? o.terminalId : null,
      terminal_id: typeof o.terminal_id === 'string' ? o.terminal_id : null,
    });
  }
  return out;
}
