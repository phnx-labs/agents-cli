import { AGENT_MODELS } from './settings';
import { runAgents } from './agentsBin';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { catalog: AgentCatalog | null; fetchedAt: number }>();

export const MODEL_CATALOG_AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'antigravity', 'grok'] as const;
export type ModelCatalogAgent = (typeof MODEL_CATALOG_AGENTS)[number];

export interface AgentCatalogModel {
  id: string;
  displayName?: string;
  alias?: string;
  isDefault?: boolean;
}

export interface AgentCatalog {
  version?: string;
  source?: string;
  models: AgentCatalogModel[];
  aliases?: Record<string, string>;
}

export async function fetchAgentCatalog(agent: string): Promise<AgentCatalog | null> {
  const cached = cache.get(agent);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.catalog;
  }
  const catalog = await runFetchAgentCatalog(agent);
  cache.set(agent, { catalog, fetchedAt: Date.now() });
  return catalog;
}

async function runFetchAgentCatalog(agent: string): Promise<AgentCatalog | null> {
  try {
    const { stdout } = await runAgents(`models ${agent} --json`, {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const rawCatalog = Array.isArray(parsed) ? parsed[0]?.catalog : null;
    if (!rawCatalog || typeof rawCatalog !== 'object') return null;
    const rawModels: unknown = rawCatalog.models;
    if (!Array.isArray(rawModels)) return null;
    const models: AgentCatalogModel[] = rawModels
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
      .map((m) => ({
        id: typeof m.id === 'string' ? m.id : '',
        displayName: typeof m.displayName === 'string' ? m.displayName : undefined,
        alias: typeof m.alias === 'string' ? m.alias : undefined,
        isDefault: typeof m.isDefault === 'boolean' ? m.isDefault : undefined,
      }))
      .filter((m) => m.id.length > 0);
    if (models.length === 0) return null;
    const aliases =
      rawCatalog.aliases && typeof rawCatalog.aliases === 'object'
        ? (Object.fromEntries(
            Object.entries(rawCatalog.aliases as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string',
            ),
          ) as Record<string, string>)
        : undefined;
    return {
      version: typeof rawCatalog.version === 'string' ? rawCatalog.version : undefined,
      source: typeof rawCatalog.source === 'string' ? rawCatalog.source : undefined,
      models,
      aliases,
    };
  } catch {
    return null;
  }
}

export async function fetchAgentModels(agent: string): Promise<string[]> {
  const catalog = await fetchAgentCatalog(agent);
  if (!catalog) return AGENT_MODELS[agent] || [];
  return catalog.models.map((m) => m.id);
}

export async function fetchAllAgentModels(): Promise<Record<string, string[]>> {
  const entries = await Promise.all(
    MODEL_CATALOG_AGENTS.map(async (a) => [a, await fetchAgentModels(a)] as const),
  );
  return Object.fromEntries(entries);
}

export async function isAgentInstalled(agent: string): Promise<boolean> {
  return (await fetchAgentCatalog(agent)) !== null;
}

export async function checkInstalledAgentsViaCli(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    MODEL_CATALOG_AGENTS.map(async (a) => [a, await isAgentInstalled(a)] as const),
  );
  return { ...Object.fromEntries(entries), shell: true };
}

export async function resolveAlias(agent: string, alias: string): Promise<string | null> {
  const catalog = await fetchAgentCatalog(agent);
  if (!catalog) return null;
  const direct = catalog.aliases?.[alias];
  if (direct) return direct;
  const byMarker = catalog.models.find((m) => m.alias === alias);
  return byMarker?.id ?? null;
}

export function clearAgentModelsCache(): void {
  cache.clear();
}
