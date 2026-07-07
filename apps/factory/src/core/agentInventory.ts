import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { AgentsViewJsonAgent, sessionUsedPercent } from './resumeInBest';
import { runAgents } from './agentsBin';
const AGENTS_SYSTEM_CONFIG_PATH = path.join(homedir(), '.agents-system', 'agents.yaml');
const RUN_STRATEGIES = new Set(['pinned', 'available', 'balanced']);

export type AgentRunStrategy = 'pinned' | 'available' | 'balanced';

export interface AgentInventoryVersion {
  version: string;
  isDefault: boolean;
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  sessionUsedPercent: number;
  lastActive: string | null;
  path: string;
}

export interface AgentInventory {
  agent: string;
  strategy: AgentRunStrategy;
  defaultVersion: string | null;
  defaultAccount: string | null;
  defaultPlan: string | null;
  signedInCount: number;
  healthyCount: number;
  canRotate: boolean;
  versions: AgentInventoryVersion[];
}

export function normalizeRunStrategy(value: unknown): AgentRunStrategy {
  if (typeof value !== 'string') return 'pinned';
  // 'rotate' is a deprecated alias kept so old agents.yaml configs still load.
  if (value === 'rotate') return 'balanced';
  return RUN_STRATEGIES.has(value) ? (value as AgentRunStrategy) : 'pinned';
}

export function readAgentRunStrategyFromConfig(
  config: Record<string, unknown> | null | undefined,
  agentKey: string,
): AgentRunStrategy {
  const run = config?.run;
  if (!run || typeof run !== 'object') return 'pinned';
  const agent = (run as Record<string, unknown>)[agentKey];
  if (!agent || typeof agent !== 'object') return 'pinned';
  return normalizeRunStrategy((agent as Record<string, unknown>).strategy);
}

export function setAgentRunStrategyInConfig(
  config: Record<string, unknown> | null | undefined,
  agentKey: string,
  strategy: AgentRunStrategy,
): Record<string, unknown> {
  const next = config && typeof config === 'object' ? { ...config } : {};
  const run = next.run && typeof next.run === 'object'
    ? { ...(next.run as Record<string, unknown>) }
    : {};
  const currentAgent = run[agentKey] && typeof run[agentKey] === 'object'
    ? { ...(run[agentKey] as Record<string, unknown>) }
    : {};
  currentAgent.strategy = strategy;
  run[agentKey] = currentAgent;
  next.run = run;
  return next;
}

export function summarizeAgentInventory(
  agentKey: string,
  view: AgentsViewJsonAgent,
  strategy: AgentRunStrategy,
): AgentInventory {
  const versions = view.versions.map((version) => ({
    version: version.version,
    isDefault: version.isDefault,
    signedIn: version.signedIn,
    email: version.email,
    plan: version.plan,
    usageStatus: version.usageStatus,
    sessionUsedPercent: sessionUsedPercent(version),
    lastActive: version.lastActive,
    path: version.path,
  }));
  const defaultVersion = versions.find((version) => version.isDefault) ?? versions[0] ?? null;
  const signedInCount = versions.filter((version) => version.signedIn).length;
  const healthyCount = versions.filter((version) => version.signedIn && version.usageStatus !== 'out_of_credits').length;
  return {
    agent: agentKey,
    strategy,
    defaultVersion: defaultVersion?.version ?? null,
    defaultAccount: defaultVersion?.email ?? null,
    defaultPlan: defaultVersion?.plan ?? null,
    signedInCount,
    healthyCount,
    canRotate: signedInCount > 1,
    versions,
  };
}

function loadAgentsSystemConfig(configPath: string = AGENTS_SYSTEM_CONFIG_PATH): Record<string, unknown> {
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function readAgentRunStrategy(
  agentKey: string,
  configPath: string = AGENTS_SYSTEM_CONFIG_PATH,
): AgentRunStrategy {
  return readAgentRunStrategyFromConfig(loadAgentsSystemConfig(configPath), agentKey);
}

export function writeAgentRunStrategy(
  agentKey: string,
  strategy: AgentRunStrategy,
  configPath: string = AGENTS_SYSTEM_CONFIG_PATH,
): void {
  const current = loadAgentsSystemConfig(configPath);
  const next = setAgentRunStrategyInConfig(current, agentKey, strategy);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(next, { indent: 2 }));
}

export async function fetchAgentInventory(agentKey: string): Promise<AgentInventory | null> {
  try {
    const { stdout } = await runAgents(`view ${agentKey} --json`, {
      timeout: 5000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as AgentsViewJsonAgent;
    if (!parsed || !Array.isArray(parsed.versions)) return null;
    return summarizeAgentInventory(agentKey, parsed, readAgentRunStrategy(agentKey));
  } catch {
    return null;
  }
}

// Fetches all installed agents in a single `agents view --json` call. This is
// 3-5x faster than spawning one CLI process per agent because it shares one
// network roundtrip across agents instead of running them concurrently.
export async function fetchAgentInventories(agentKeys: string[]): Promise<Record<string, AgentInventory>> {
  const wanted = new Set(agentKeys);
  try {
    const { stdout } = await runAgents('view --json', {
      timeout: 12000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as AgentsViewJsonAgent[];
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, AgentInventory> = {};
    for (const entry of parsed) {
      if (!entry || typeof entry.agent !== 'string') continue;
      if (!wanted.has(entry.agent)) continue;
      if (!Array.isArray(entry.versions)) continue;
      out[entry.agent] = summarizeAgentInventory(entry.agent, entry, readAgentRunStrategy(entry.agent));
    }
    return out;
  } catch {
    return {};
  }
}
