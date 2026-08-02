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
 * When a team meta.json exists we additionally enrich with handle/mode — but
 * its absence no longer demotes a session: older team runs whose meta dir
 * was cleaned up still get recognized via the entrypoint flag.
 *
 * Returns the TeamOrigin metadata when the session is team-origin, or null
 * when it is a normal interactive session.
 */
export function classifyTeamSession(session: SessionMeta): TeamOrigin | null {
  const metaPath = path.join(teamsAgentsDir(), session.id, 'meta.json');

  if (fs.existsSync(metaPath)) return readTeamOrigin(metaPath, session.id);

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
function readTeamOrigin(metaPath: string, sessionId: string): TeamOrigin {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    const name = typeof meta.name === 'string' && meta.name ? meta.name : undefined;
    const mode = typeof meta.mode === 'string' ? meta.mode : undefined;
    const team = typeof meta.task_name === 'string' && meta.task_name ? meta.task_name : undefined;
    const parentSessionId =
      typeof meta.parent_session_id === 'string' && meta.parent_session_id
        ? meta.parent_session_id
        : undefined;
    return { handle: name ?? sessionId.slice(0, 8), mode, team, parentSessionId };
  } catch {
    return { handle: sessionId.slice(0, 8) };
  }
}

/**
 * Attach `teamOrigin` to every team-spawned row in `sessions`, listing the
 * teams-agents directory ONCE rather than stat-ing per row.
 *
 * {@link classifyTeamSession} pays an `fs.existsSync` plus an `fs.readFileSync`
 * for every session it is handed, which is fine for a one-shot listing but a
 * syscall sink in the interactive browser, where a 500-row pool is re-filtered
 * on every hotkey. Here a single `readdir` decides which ids have a record, so
 * only the intersection is read.
 */
export function enrichTeamOrigins(sessions: SessionMeta[]): SessionMeta[] {
  const dir = teamsAgentsDir();
  let known: Set<string>;
  try {
    known = new Set(fs.readdirSync(dir));
  } catch {
    known = new Set();
  }

  return sessions.map((session) => {
    // A peer's rows are classified on the peer (its meta.json is on its disk, not
    // ours) and ride across in the --json fan-out already populated. Re-deriving
    // here would find no local record and downgrade a named teammate to a bare id.
    if (session.teamOrigin) return session;

    const origin = known.has(session.id)
      ? readTeamOrigin(path.join(dir, session.id, 'meta.json'), session.id)
      : session.isTeamOrigin
        ? { handle: session.id.slice(0, 8) }
        : null;
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
