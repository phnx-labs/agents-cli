/**
 * Build the self-reported harness inventory a device emits in `doctor --json`
 * for cross-device divergence detection (RUSH-2027).
 *
 * Kept separate from {@link ../devices/fleet-divergence.js} — which stays a pure,
 * SSH-free comparator — because this reads the live install (resource dirs,
 * installed version homes, config repos). One call produces the {@link
 * FleetInventory} that both the local baseline and every remote box serialize
 * into their doctor payload; the comparator then diffs those payloads.
 */

import { getAvailableResources, listInstalledVersions } from '../versions.js';
import { getUserAgentsDir, getSystemAgentsDir } from '../state.js';
import { readRepoState } from '../git.js';
import { ALL_AGENT_IDS } from '../agents.js';
import { FLEET_RESOURCE_KINDS, type FleetInventory, type RepoState } from './fleet-divergence.js';

function toRepoState(snap: ReturnType<typeof readRepoState>): RepoState | null {
  if (!snap) return null;
  return { branch: snap.branch, head: snap.head, dirty: snap.dirty };
}

/**
 * Collect this machine's harness inventory: installed resources per kind,
 * installed version ids per agent, and `.agents`/`.system` repo state. Pure
 * reads — never mutates the install. `promptcuts` (a single present/absent bit
 * in {@link getAvailableResources}) is surfaced as a one-element list so it
 * compares like any other named resource.
 */
export function collectLocalFleetInventory(cwd: string = process.cwd()): FleetInventory {
  const available = getAvailableResources(cwd);
  const resources = {} as Record<(typeof FLEET_RESOURCE_KINDS)[number], string[]>;
  for (const kind of FLEET_RESOURCE_KINDS) {
    if (kind === 'promptcuts') {
      resources[kind] = available.promptcuts ? ['promptcuts.yaml'] : [];
    } else if (kind === 'rules') {
      // getAvailableResources exposes top-level rules under `memory`.
      resources[kind] = [...available.memory].sort();
    } else {
      resources[kind] = [...(available[kind] ?? [])].sort();
    }
  }

  const agentVersions: Record<string, string[]> = {};
  for (const agent of ALL_AGENT_IDS) {
    const versions = listInstalledVersions(agent);
    if (versions.length > 0) agentVersions[agent] = [...versions].sort();
  }

  return {
    resources,
    agentVersions,
    repos: {
      agents: toRepoState(readRepoState(getUserAgentsDir())),
      system: toRepoState(readRepoState(getSystemAgentsDir())),
    },
  };
}
