import { hostScore } from './launchHost';
import { AutoLaunchPreference, isAutoLaunchEnabled, isAutoLaunchPreferred } from './deviceAutoLaunch';

export interface LaunchHistoryEntry {
  launches: number;
  successes: number;
  lastLaunchAt: number;
}

export type LaunchHistory = Record<string, LaunchHistoryEntry>;

export interface CachedLaunchDevice {
  name: string;
  online: boolean;
  sshReachable: boolean;
  running: number;
  loadAvg1?: number;
  memPercent?: number;
  usableAgents: Record<string, boolean>;
  fetchedAt: number;
}

export interface LaunchHealthCache {
  devices: CachedLaunchDevice[];
  refreshedAt: number;
}

export const LAUNCH_HISTORY_KEY = 'agents.launchHistory.v1';
export const LAUNCH_HEALTH_KEY = 'agents.launchHealth.v1';
export const LAUNCH_HEALTH_MAX_AGE_MS = 5 * 60_000;

export class LaunchHistoryRecorder {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly load: () => LaunchHistory,
    private readonly save: (history: LaunchHistory) => PromiseLike<void>,
  ) {}

  record(device: string, success: boolean, launchedAt = Date.now()): Promise<void> {
    const operation = this.pending.then(async () => {
      await this.save(recordLaunch(this.load(), device, success, launchedAt));
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

function normalized(name: string): string {
  return name.trim().toLowerCase();
}

export function recordLaunch(
  history: LaunchHistory,
  device: string,
  success: boolean,
  launchedAt = Date.now(),
): LaunchHistory {
  const key = normalized(device);
  const previous = history[key] ?? { launches: 0, successes: 0, lastLaunchAt: 0 };
  return {
    ...history,
    [key]: {
      launches: previous.launches + 1,
      successes: previous.successes + Number(success),
      lastLaunchAt: launchedAt,
    },
  };
}

function historyPreference(entry: LaunchHistoryEntry | undefined, now: number): number {
  if (!entry) return 0;
  const ageHours = Math.max(0, now - entry.lastLaunchAt) / 3_600_000;
  const recency = 18 / (1 + ageHours / 24);
  const frequency = Math.min(12, Math.log2(entry.launches + 1) * 3);
  const successRate = entry.launches > 0 ? (entry.successes / entry.launches) * 8 : 0;
  return recency + frequency + successRate;
}

/**
 * Rank a warm cache without I/O. Unreachable, offline, stale, agent-unusable,
 * or disabled devices are excluded before history and load are considered.
 * Preferred devices receive a ranking bonus.
 */
export function pickCachedLaunchHost(
  agentKey: string,
  cache: LaunchHealthCache | undefined,
  history: LaunchHistory,
  preferences: Record<string, AutoLaunchPreference> = {},
  now = Date.now(),
): string | null {
  if (!cache || now - cache.refreshedAt > LAUNCH_HEALTH_MAX_AGE_MS) return null;
  const eligible = cache.devices.filter(
    (device) =>
      device.online &&
      device.sshReachable &&
      device.usableAgents[agentKey] === true &&
      isAutoLaunchEnabled(preferences, device.name),
  );
  if (eligible.length === 0) return null;

  // The preference bonus lives inside hostScore (launchHost.ts) so the balanced
  // pool pick applies it identically — pass the flag, don't re-implement it.
  const rank = (device: CachedLaunchDevice): number =>
    hostScore({ ...device, preferred: isAutoLaunchPreferred(preferences, device.name) }) -
    historyPreference(history[normalized(device.name)], now);

  let best = eligible[0];
  let bestRank = rank(best);
  for (const device of eligible.slice(1)) {
    const deviceRank = rank(device);
    if (deviceRank < bestRank) {
      best = device;
      bestRank = deviceRank;
    }
  }
  return best.name;
}
