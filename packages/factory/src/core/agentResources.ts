import { runAgents } from './agentsBin';

export const RESOURCE_KINDS = [
  'commands', 'skills', 'hooks', 'mcp', 'rules', 'plugins', 'workflows', 'subagents',
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface AgentResourceRepo {
  repo: string;
  root: string;
  counts: Record<ResourceKind, number>;
  git?: { branch?: string; ahead?: number; behind?: number; dirty?: number };
}

interface InspectJson {
  repo?: string;
  root?: string;
  resources?: Partial<Record<ResourceKind, { count?: number }>>;
  git?: { branch?: string; ahead?: number; behind?: number; dirty?: number };
}

// `agents inspect --json` walks the whole DotAgents tree to compute resource
// sizes, so it can take 10-20s on a large ~/.agents (hundreds of MB). Give it
// room rather than flashing an empty state on big repos.
const INSPECT_TIMEOUT_MS = 25_000;

async function inspectRepo(target: string, cwd?: string): Promise<AgentResourceRepo | null> {
  try {
    const { stdout } = await runAgents(`inspect ${target} --json`, {
      timeout: INSPECT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      cwd,
    });
    const parsed = JSON.parse(stdout) as InspectJson;
    if (!parsed || typeof parsed !== 'object') return null;
    const res = parsed.resources ?? {};
    const counts = {} as Record<ResourceKind, number>;
    for (const kind of RESOURCE_KINDS) {
      counts[kind] = Number(res[kind]?.count) || 0;
    }
    return {
      repo: String(parsed.repo ?? target),
      root: String(parsed.root ?? ''),
      counts,
      git: parsed.git
        ? { branch: parsed.git.branch, ahead: parsed.git.ahead, behind: parsed.git.behind, dirty: parsed.git.dirty }
        : undefined,
    };
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = 60_000;
let cache: { data: AgentResourceRepo[]; fetchedAt: number; workspace: string | undefined } | null = null;
let inflight: Promise<AgentResourceRepo[]> | null = null;

export function invalidateAgentResourcesCache(): void {
  cache = null;
}

// Inspect the standard DotAgents repos (user + system, plus project when a
// workspace is open) and return their capability counts. Cached for 60s with
// inflight de-duplication, mirroring the agent-inventory cache.
export async function getAgentResources(
  workspacePath?: string,
  force = false,
): Promise<AgentResourceRepo[]> {
  if (!force && cache && cache.workspace === workspacePath && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const targets: Array<[string, string | undefined]> = [
      ['user', undefined],
      ['system', undefined],
    ];
    if (workspacePath) targets.push(['project', workspacePath]);
    const results = await Promise.all(targets.map(([t, cwd]) => inspectRepo(t, cwd)));
    const data = results.filter((r): r is AgentResourceRepo => r !== null);
    cache = { data, fetchedAt: Date.now(), workspace: workspacePath };
    return data;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
