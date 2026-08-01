// Usage-based agent-type selection for the smart "New Agent" launch (RUSH-2029).
//
// The generic `agents.newAgent` command used to hard-code the configured default
// (Claude). This module aggregates recent session history into a per-agent-type
// preference so the command can launch the agent the user actually reaches for,
// weighting the last 24 hours heavily while still honoring longer-term frequency.
//
// Pure + VS Code-free so it is unit-testable against fixture session history.
// The caller feeds it the `RemoteSession[]` returned by the existing fleet-wide
// `fetchRecapSessions()` sweep (which already normalizes every host's history
// onto `agentType` + `lastActivityMs`/`startedAtMs`).

/** Minimal view of a session record the selector reads. `RemoteSession` from
 *  `remoteSessions.ts` is a structural superset, so callers pass those directly. */
export interface UsageSession {
  /** Lowercased agent key ('claude' | 'codex' | ...), as normalized onto RemoteSession.agentType. */
  agentType: string;
  /** Epoch ms of the most recent observed activity; 0 when unknown. */
  lastActivityMs: number;
  /** Host-reported wall-clock start (epoch ms); used as the activity fallback. */
  startedAtMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A session inside the last 24h counts for this much; older sessions count for 1.
// The gap is what makes recency dominate frequency without erasing it: three
// month-old Codex sessions (3 pts) still lose to one Claude session today (5 pts),
// but a single stale session can't outweigh a consistent longer-term habit.
const RECENT_WEIGHT = 5;
const OLDER_WEIGHT = 1;

/** The activity clock for a session: its last observed write, or its start when no
 *  activity was recorded (a status-only remote row). 0 when neither is known. */
function activityMsOf(s: UsageSession): number {
  return s.lastActivityMs > 0 ? s.lastActivityMs : s.startedAtMs > 0 ? s.startedAtMs : 0;
}

export interface AgentUsageScore {
  agentType: string;
  /** Recency-weighted preference score (higher = preferred). */
  score: number;
  /** Newest activity epoch ms seen for this agent — the tie-breaker. */
  lastActivityMs: number;
  /** Raw session count for this agent (diagnostics / UI). */
  sessions: number;
}

/**
 * Aggregate session history into a per-agent-type preference, ranked most-preferred
 * first. Only agents present in `installed` are scored — an uninstalled or
 * signed-out agent can never be selected (acceptance: "Uninstalled or unsigned-in
 * agents are excluded"). Ties (equal score) break toward the most recently active.
 *
 * @param sessions  Historical sessions across the fleet (any order).
 * @param installed Agent keys that are installed + usable right now.
 * @param now       Reference clock (epoch ms) — injected so tests are deterministic.
 */
export function rankAgentsByUsage(
  sessions: readonly UsageSession[],
  installed: readonly string[],
  now: number,
): AgentUsageScore[] {
  const usable = new Set(installed.map((k) => k.toLowerCase()));
  const byAgent = new Map<string, AgentUsageScore>();

  for (const s of sessions) {
    const agentType = (s.agentType || '').toLowerCase();
    if (!agentType || !usable.has(agentType)) continue;
    const activityMs = activityMsOf(s);
    const recent = activityMs > 0 && now - activityMs <= DAY_MS;
    const weight = recent ? RECENT_WEIGHT : OLDER_WEIGHT;

    const cur = byAgent.get(agentType) ?? { agentType, score: 0, lastActivityMs: 0, sessions: 0 };
    cur.score += weight;
    cur.sessions += 1;
    if (activityMs > cur.lastActivityMs) cur.lastActivityMs = activityMs;
    byAgent.set(agentType, cur);
  }

  return [...byAgent.values()].sort(
    (a, b) => b.score - a.score || b.lastActivityMs - a.lastActivityMs,
  );
}

/**
 * The smart agent-type choice for "New Agent": the highest-ranked agent by usage,
 * falling back to `defaultKey` when no installed agent has any usable history
 * (acceptance: "Fall back to the configured default agent when there is no
 * meaningful history"). Returns null only when the default itself is not installed
 * and no history exists — the caller then leaves the flow untouched.
 *
 * @param sessions   Historical sessions across the fleet.
 * @param installed  Agent keys that are installed + usable right now.
 * @param defaultKey The configured default agent key (e.g. 'claude').
 * @param now        Reference clock (epoch ms).
 */
export function pickAgentByUsage(
  sessions: readonly UsageSession[],
  installed: readonly string[],
  defaultKey: string,
  now: number,
): string | null {
  const ranked = rankAgentsByUsage(sessions, installed, now);
  if (ranked.length > 0) return ranked[0].agentType;
  const usable = new Set(installed.map((k) => k.toLowerCase()));
  const fallback = defaultKey.toLowerCase();
  return usable.has(fallback) ? fallback : null;
}
