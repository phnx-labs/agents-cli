/**
 * MCP writer — thin dispatcher into `installMcpServers` from `lib/mcp.ts`.
 *
 * The per-agent format handling (Claude CLI, Codex TOML, Cursor JSON, etc.)
 * lives in lib/mcp.ts; we keep it there to avoid the import cycle with
 * `versions.ts`. The writer simply hands the selection to that function.
 */
import * as fs from 'fs';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { installMcpServers } from '../../mcp.js';
import { getMcpConfigPathForHome } from '../../agents.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildMcpWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'mcp',
    agent,
    write({ version, versionHome, selection, cwd }: WriteArgs<string[]>): WriteResult {
      const r = installMcpServers(agent, version, versionHome, selection, { cwd });
      // Forward r.errors: dropping them is what let a harness with no config
      // writer report a clean sync while writing nothing (RUSH-2677).
      // All applied servers land in the one canonical config file — that file
      // is the artifact whose deletion must read as stale (#2398). Recorded
      // only when it verifiably exists after the write, so an agent whose CLI
      // wrote elsewhere can never produce a perpetually-stale manifest.
      const configPath = getMcpConfigPathForHome(agent, versionHome);
      const paths = r.applied.length > 0 && fs.existsSync(configPath) ? [configPath] : [];
      return { synced: r.applied, paths, ...(r.errors.length ? { errors: r.errors } : {}) };
    },
  };
}

export const mcpWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('mcp')) m[agent] = buildMcpWriter(agent);
  return m;
});
