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

import { getAvailableResources, getVersionHomePath, isVersionIsolated, listInstalledVersions } from '../versions.js';
import { supports } from '../capabilities.js';
import { checkVersionHookWiring } from '../hooks.js';
import { getUserAgentsDir, getSystemAgentsDir } from '../state.js';
import { readRepoState } from '../git.js';
import {
  ALL_AGENT_IDS,
  accountDisplayLabel,
  credentialPresence,
  getAccountInfo,
  supportsAccountInspection,
} from '../agents.js';
import type { AgentId } from '../types.js';
import {
  FLEET_RESOURCE_KINDS,
  type FleetHookRuntimeState,
  type FleetInventory,
  type FleetVersionSignIn,
  type RepoState,
} from './fleet-divergence.js';

function toRepoState(snap: ReturnType<typeof readRepoState>): RepoState | null {
  if (!snap) return null;
  return { branch: snap.branch, head: snap.head, dirty: snap.dirty };
}

/**
 * Probe every installed version's sign-in state, per agent. For each version we
 * read its own home's account (via the shim-set config dir) and, when logged
 * out, decide whether that is PROVABLE: an agent that can't be inspected
 * (`!supportsAccountInspection`) never claims logged out, and a version that
 * merely lacks its own credential but shares the global login (`active`) is
 * signed in, not out. Pure reads (file-presence + cheap account parse), no
 * network, no keychain prompt. Only agents with at least one installed version
 * appear, so the map lines up with {@link FleetInventory.agentVersions}.
 */
export async function collectLocalFleetSignIn(): Promise<Record<string, FleetVersionSignIn[]>> {
  const out: Record<string, FleetVersionSignIn[]> = {};
  await Promise.all(
    ALL_AGENT_IDS.map(async (agent: AgentId) => {
      const versions = listInstalledVersions(agent);
      if (versions.length === 0) return;
      const rows = await Promise.all(
        versions.map(async (version): Promise<FleetVersionSignIn> => {
          const home = getVersionHomePath(agent, version);
          let signedIn = false;
          let account: string | null = null;
          try {
            const info = await getAccountInfo(agent, home);
            signedIn = info.signedIn;
            account = accountDisplayLabel(info) || null;
          } catch {
            /* advisory only — treat as logged out, provability decided below */
          }
          // Provable logout: the agent is inspectable AND the credential is absent
          // from BOTH the version home and the active/global HOME. An opaque or
          // keychain-only agent, or one sharing the global login, is never a
          // provable logout.
          let provable = false;
          if (!signedIn && supportsAccountInspection(agent)) {
            const presence = credentialPresence(agent, home);
            // `knownLocation` is load-bearing: an agent can sit in the inspection
            // set with no credential path (cursor does), and then both probes are
            // false only because there is nothing to look for. Treating that as a
            // provable logout prints a CRITICAL for a version that is signed in.
            provable = presence.knownLocation && !presence.perVersion && !presence.active;
          }
          return { version, signedIn, account, provable };
        }),
      );
      out[agent] = rows;
    }),
  );
  return out;
}

/**
 * Collect this machine's harness inventory: installed resources per kind,
 * installed version ids per agent, `.agents`/`.system` repo state, and
 * per-version sign-in. Pure reads — never mutates the install. `promptcuts` (a
 * single present/absent bit in {@link getAvailableResources}) is surfaced as a
 * one-element list so it compares like any other named resource.
 */
export async function collectLocalFleetInventory(cwd: string = process.cwd()): Promise<FleetInventory> {
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
  const hookRuntime: Record<string, Record<string, FleetHookRuntimeState>> = {};
  for (const agent of ALL_AGENT_IDS) {
    const versions = listInstalledVersions(agent);
    if (versions.length > 0) {
      agentVersions[agent] = [...versions].sort();
      hookRuntime[agent] = Object.fromEntries(versions.map((version) => {
        const eligible = supports(agent, 'hooks', version).ok && !isVersionIsolated(agent, version);
        if (!eligible) return [version, 'not-applicable'];
        const state: FleetHookRuntimeState = checkVersionHookWiring(agent, version).runtimeBroken.length > 0
          ? 'broken'
          : 'healthy';
        return [version, state];
      }));
    }
  }

  return {
    resources,
    agentVersions,
    repos: {
      agents: toRepoState(readRepoState(getUserAgentsDir())),
      system: toRepoState(readRepoState(getSystemAgentsDir())),
    },
    signIn: await collectLocalFleetSignIn(),
    hookRuntime,
  };
}
