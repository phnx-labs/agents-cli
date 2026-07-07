/**
 * Permissions writer — selection is a list of permission GROUP names. We
 * build the PermissionSet from the discovered groups, then dispatch into the
 * per-agent format writer in `lib/permissions.ts:applyPermissionsToVersion`.
 *
 * The per-agent format work lives in lib/permissions.ts because the format
 * conversions (Claude settings.json vs Codex TOML+rules vs Gemini tools vs
 * Antigravity permissions{} vs Grok [permission].rules) are tightly coupled
 * to the converters defined alongside them.
 */
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import {
  applyPermissionsToVersion as applyPermsToVersion,
  buildPermissionsFromGroups,
} from '../../permissions.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildPermissionsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'permissions',
    agent,
    write({ versionHome, selection }: WriteArgs<string[]>): WriteResult {
      if (selection.length === 0) return { synced: [] };
      const built = buildPermissionsFromGroups(selection);
      const hasAllow = built.allow.length > 0;
      const hasDeny = (built.deny?.length ?? 0) > 0;
      if (!hasAllow && !hasDeny) return { synced: [] };
      const r = applyPermsToVersion(agent, built, versionHome, true);
      return { synced: r.success ? selection : [] };
    },
  };
}

export const permissionsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('allowlist')) m[agent] = buildPermissionsWriter(agent);
  return m;
});
