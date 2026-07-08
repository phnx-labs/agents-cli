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

  if (fs.existsSync(metaPath)) {
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof meta.name === 'string' && meta.name ? meta.name : undefined;
      const handle = name ?? session.id.slice(0, 8);
      const mode = typeof meta.mode === 'string' ? meta.mode : undefined;
      return { handle, mode };
    } catch {
      return { handle: session.id.slice(0, 8) };
    }
  }

  if (session.isTeamOrigin) {
    return { handle: session.id.slice(0, 8) };
  }

  return null;
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
