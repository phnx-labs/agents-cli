import * as fs from 'fs';
import * as path from 'path';

import { buildRoutineListJson } from '../../commands/routines.js';
import { serializeActiveSessionsForJson, serializeSessionsJson } from '../../commands/sessions.js';
import { getConfigValue } from '../device-config.js';
import { querySessions } from '../session/db.js';
import { readActiveSessionsCache } from '../session/session-cache.js';
import { getRuntimeStateDir } from '../state.js';
import type { WatchdogTickResult } from '../watchdog/runner.js';

export interface MenubarSnapshot {
  version: 1;
  capturedAt: string;
  routines: Record<string, unknown>[];
  recentSessions: Record<string, unknown>[];
  activeSessions: Record<string, unknown>[];
  watchdog: {
    enabled: boolean;
    lastTick: Pick<WatchdogTickResult, 'didNudge' | 'counts'> | null;
  };
}

export function readLastWatchdogTick(
  stateDir = path.join(getRuntimeStateDir(), 'watchdog'),
): WatchdogTickResult | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'last-tick.json'), 'utf-8')) as WatchdogTickResult;
  } catch {
    return null;
  }
}

/** One-process read model for AGI Menu's repeating three-minute refresh. */
export async function computeMenubarSnapshot(): Promise<MenubarSnapshot> {
  const [routines, recent] = await Promise.all([
    Promise.resolve(buildRoutineListJson()),
    Promise.resolve(querySessions({ limit: 40, skipExistenceCheck: true })),
  ]);
  const active = readActiveSessionsCache('local');
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    routines,
    recentSessions: JSON.parse(serializeSessionsJson(recent)) as Record<string, unknown>[],
    activeSessions: serializeActiveSessionsForJson(active?.sessions ?? []) as Record<string, unknown>[],
    watchdog: {
      enabled: getConfigValue('watchdog.enabled').value === true,
      lastTick: (() => {
        const tick = readLastWatchdogTick();
        return tick ? { didNudge: tick.didNudge, counts: tick.counts } : null;
      })(),
    },
  };
}
