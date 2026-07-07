/**
 * MCP writer — thin dispatcher into `installMcpServers` from `lib/mcp.ts`.
 *
 * The per-agent format handling (Claude CLI, Codex TOML, Cursor JSON, etc.)
 * lives in lib/mcp.ts; we keep it there to avoid the import cycle with
 * `versions.ts`. The writer simply hands the selection to that function.
 */
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { installMcpServers } from '../../mcp.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildMcpWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'mcp',
    agent,
    write({ version, versionHome, selection, cwd }: WriteArgs<string[]>): WriteResult {
      const r = installMcpServers(agent, version, versionHome, selection, { cwd });
      return { synced: r.applied };
    },
  };
}

export const mcpWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('mcp')) m[agent] = buildMcpWriter(agent);
  return m;
});
