/**
 * Classification and filtering of team-spawned sessions.
 *
 * Sessions launched by `agents teams` carry an 'sdk-cli' entrypoint and
 * optionally have a meta.json with handle/mode info. This module determines
 * whether a session is team-origin and splits session lists into visible
 * and hidden groups for the picker UI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionMeta, TeamOrigin } from './types.js';
import { sanitizeForTerminal } from './parse.js';
import { getTeamsAgentsDir } from '../state.js';

const HOME = os.homedir();

// Default path; tests can override via AGENTS_TEAMS_DIR env var.
/** Resolve the directory containing per-session team metadata files. */
function teamsAgentsDir(): string {
  return process.env.AGENTS_TEAMS_DIR ?? getTeamsAgentsDir();
}

/**
 * Determine whether `session` was spawned by `agents teams`.
 *
 * Primary signal is `session.isTeamOrigin`, captured at scan time from the
 * JSONL `entrypoint` field ('sdk-cli' for team spawns, 'cli' for real CLI).
 * When a team meta.json exists we additionally enrich with handle/mode/team and
 * the orchestrator that spawned it — but its absence no longer demotes a
 * session: older team runs whose meta dir was cleaned up still get recognized
 * via the entrypoint flag.
 *
 * Returns the TeamOrigin metadata when the session is team-origin, or null
 * when it is a normal interactive session.
 */
export function classifyTeamSession(session: SessionMeta): TeamOrigin | null {
  const origin = teamOriginIndex().get(session.id);
  if (origin) return origin;

  if (session.isTeamOrigin) {
    return { handle: session.id.slice(0, 8) };
  }

  return null;
}

/**
 * Parse one teammate `meta.json` into a {@link TeamOrigin}. Degrades to a bare
 * handle when the file is unreadable or malformed — a teammate whose record we
 * can't parse is still a teammate.
 */
function readTeamOrigin(metaPath: string, agentId: string): { origin: TeamOrigin; sessionId?: string } {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      origin: {
        handle: str(meta.name) ?? agentId.slice(0, 8),
        mode: str(meta.mode),
        team: str(meta.task_name),
        parentSessionId: str(meta.parent_session_id),
      },
      sessionId: str(meta.remote_session_id),
    };
  } catch {
    return { origin: { handle: agentId.slice(0, 8) } };
  }
}

/**
 * A team name / handle as it is safe to render: a real string, terminal escapes
 * stripped, or undefined.
 *
 * These values reach the row and the preview pane, and for a peer's row they are
 * whatever JSON that machine sent — `parseRemoteList` copies the object through
 * without inspecting its fields, so neither the type nor the content is ours to
 * assume. A non-string `spawnedTeam` used to throw out of `teamBadge`, which runs
 * on every row, taking down the whole listing rather than one entry.
 */
export function safeTeamText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return sanitizeForTerminal(value);
}

/** Cached teammate index; the directory is small (teams GC it after 7 days). */
let originIndexCache: Map<string, TeamOrigin> | null = null;

/** Drop the cached teammate index — for tests that rewrite AGENTS_TEAMS_DIR. */
export function _resetTeamOriginIndex(): void {
  originIndexCache = null;
}

/**
 * Every teammate record, keyed by the session ids it can be reached under.
 *
 * A teammate's directory name is its **agent id**, which is only sometimes the
 * id of the transcript it produced: the harness mints its own session id, and
 * the spawn records it separately as `remote_session_id`. Keying the lookup on
 * the directory name alone therefore missed most teammates — on a live box, 14
 * of 16 records were reachable only by `remote_session_id` — so a teammate row
 * could not name its team however good the record was. Both keys are registered.
 *
 * Read once per process rather than per row: the old per-session `existsSync` +
 * `readFileSync` cost a pair of syscalls for every row in the pool, which the
 * interactive browser re-pays on each hotkey.
 */
function teamOriginIndex(): Map<string, TeamOrigin> {
  if (originIndexCache) return originIndexCache;

  const dir = teamsAgentsDir();
  const index = new Map<string, TeamOrigin>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const agentId of entries) {
    const metaPath = path.join(dir, agentId, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    const { origin, sessionId } = readTeamOrigin(metaPath, agentId);
    index.set(agentId, origin);
    if (sessionId) index.set(sessionId, origin);
  }

  originIndexCache = index;
  return index;
}

/**
 * Attach `teamOrigin` to every team-spawned row in `sessions`, from the shared
 * teammate index rather than a stat per row.
 */
export function enrichTeamOrigins(sessions: SessionMeta[]): SessionMeta[] {
  const index = teamOriginIndex();

  return sessions.map((session) => {
    // A peer's rows are classified on the peer (its meta.json is on its disk, not
    // ours) and ride across in the --json fan-out already populated. Re-deriving
    // here would find no local record and downgrade a named teammate to a bare id.
    if (session.teamOrigin) return session;

    const origin =
      index.get(session.id) ?? (session.isTeamOrigin ? { handle: session.id.slice(0, 8) } : null);
    return origin ? { ...session, teamOrigin: origin } : session;
  });
}

/** Result of splitting sessions into visible and hidden (team-origin) groups. */
export interface FilterResult {
  visible: SessionMeta[];
  hiddenCount: number;
}

/**
 * Split `sessions` into visible and hidden (team-origin) groups.
 * When `showTeams` is true every session is visible and `teamOrigin` is
 * populated on team sessions for display. When false, team sessions are
 * excluded and counted in `hiddenCount`.
 */
export function filterTeamSessions(
  sessions: SessionMeta[],
  showTeams: boolean,
): FilterResult {
  let hiddenCount = 0;
  const visible: SessionMeta[] = [];

  for (const session of sessions) {
    const origin = classifyTeamSession(session);
    if (origin !== null) {
      if (showTeams) {
        visible.push({ ...session, teamOrigin: origin });
      } else {
        hiddenCount++;
      }
    } else {
      visible.push(session);
    }
  }

  return { visible, hiddenCount };
}
