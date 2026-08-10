// Pure candidate building for `Agents: Resume (Pick Harness)` — which harness
// to offer when the user keeps the session's device but swaps the agent. No VS
// Code, no IO: the vscode side feeds in BUILT_IN_AGENTS and (when the session
// is local) one `fetchAgentInventories()` read.

import type { AgentInventory } from './agentInventory';

/** One row in the harness picker. */
export interface HarnessOption {
  /** Harness key as the CLI names it ('claude', 'codex', …). */
  agent: string;
  /** Display name ('Claude', 'Codex', …). */
  title: string;
  /** Installed versions with a live login; 0 when the inventory is unknown. */
  signedInCount: number;
  /** Signed-in versions that are not out of credits. */
  healthyCount: number;
}

/**
 * The harnesses to offer for a cross-harness resume: every presented agent
 * except `shell` (a shell tab has no conversation to continue) and the harness
 * the session already runs in (switching to yourself is `Agents: Resume`).
 *
 * Ranked most-usable first so the top row is the sensible default: healthy
 * installs, then any signed-in install, then name. An empty `inventories` map
 * (an offloaded session — this box can't see the device's installs) still
 * yields the full list, just unranked; the launch then fails loud on the
 * device if the harness isn't installed there.
 */
export function buildHarnessOptions(
  agents: ReadonlyArray<{ key: string; title: string }>,
  inventories: Record<string, AgentInventory>,
  currentAgent: string | undefined,
): HarnessOption[] {
  return agents
    .filter((a) => a.key !== 'shell' && a.key !== currentAgent)
    .map((a) => {
      const inv = inventories[a.key];
      return {
        agent: a.key,
        title: a.title,
        signedInCount: inv?.signedInCount ?? 0,
        healthyCount: inv?.healthyCount ?? 0,
      };
    })
    .sort(
      (x, y) =>
        y.healthyCount - x.healthyCount ||
        y.signedInCount - x.signedInCount ||
        x.title.localeCompare(y.title),
    );
}
