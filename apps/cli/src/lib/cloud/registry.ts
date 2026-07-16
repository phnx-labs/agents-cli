/**
 * Cloud provider registry.
 *
 * Reads the `cloud` section of agents.yaml, lazily instantiates provider
 * implementations, and exposes lookup helpers used by the `agents cloud` commands.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type { CloudProvider, CloudProviderId, CloudConfig } from './types.js';
import { RushCloudProvider } from './rush.js';
import { CodexCloudProvider } from './codex.js';
import { FactoryCloudProvider } from './factory.js';
import { AntigravityCloudProvider } from './antigravity.js';
import { HostCloudProvider } from './host.js';
import { getUserAgentsDir } from '../state.js';
import { AGENTS } from '../agents.js';
import type { AgentId } from '../types.js';

const META_FILE = path.join(getUserAgentsDir(), 'agents.yaml');

let _config: CloudConfig | null = null;

/** Parse the `cloud` section from agents.yaml, caching the result for the process lifetime. */
function loadCloudConfig(): CloudConfig {
  if (_config) return _config;

  if (!fs.existsSync(META_FILE)) {
    _config = {};
    return _config;
  }

  try {
    const raw = fs.readFileSync(META_FILE, 'utf-8');
    const data = yaml.parse(raw) as Record<string, unknown>;
    _config = (data?.cloud as CloudConfig) ?? {};
  } catch {
    _config = {};
  }
  return _config;
}

const providers: Map<CloudProviderId, CloudProvider> = new Map();

/** Instantiate all provider implementations once, keyed by their ID. */
function initProviders(): void {
  if (providers.size > 0) return;

  const config = loadCloudConfig();

  providers.set('rush', new RushCloudProvider());
  providers.set('codex', new CodexCloudProvider(config.providers?.codex));
  providers.set('factory', new FactoryCloudProvider(config.providers?.factory));
  providers.set('antigravity', new AntigravityCloudProvider(config.providers?.antigravity));
  // Your own machines (agents hosts / agents devices) over SSH. No agent
  // auto-routes here — it's always an explicit --provider host / --host choice.
  providers.set('host', new HostCloudProvider());
}

/**
 * The cloud provider an agent dispatches to by default. Reads the canonical
 * `cloudProvider` field on the agent registry entry — one source of truth, no
 * side map. Returns undefined for agents with no native cloud.
 */
export function nativeProviderForAgent(agentId: string): CloudProviderId | undefined {
  const agent = AGENTS[agentId as AgentId];
  return agent?.cloudProvider;
}

/** Look up a provider by ID, throwing if the ID is unknown. */
export function getProvider(id: CloudProviderId): CloudProvider {
  initProviders();
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown cloud provider: ${id}. Available: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
}

/** Return the user's configured default provider, falling back to 'rush'. */
export function getDefaultProviderId(): CloudProviderId {
  const config = loadCloudConfig();
  return config.default_provider ?? 'rush';
}

/** Return every registered provider (used by `agents cloud providers`). */
export function getAllProviders(): CloudProvider[] {
  initProviders();
  return [...providers.values()];
}

/**
 * Resolve the active provider for a dispatch.
 *
 * Precedence: explicit `--provider` > the agent's native cloud
 * (`cloudProvider`) > configured `cloud.default_provider` > `rush`. This is
 * what makes `agents cloud run --agent droid` land on Factory and
 * `--agent codex` land on Codex Cloud without the user naming a provider.
 *
 * Callers that already hold a concrete provider id (e.g. resolving a stored
 * task's provider) pass it as `explicit` and the agent arg is ignored.
 */
export function resolveProvider(explicit?: string, agentId?: string): CloudProvider {
  const id = (explicit
    ?? (agentId ? nativeProviderForAgent(agentId) : undefined)
    ?? getDefaultProviderId()) as CloudProviderId;
  return getProvider(id);
}
