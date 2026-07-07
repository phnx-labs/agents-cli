/**
 * Package registry client -- search, resolve, and install from remote registries.
 *
 * Queries the MCP registry (registry.modelcontextprotocol.io) and future skill
 * registries to find packages, then resolves them into installable entries
 * with transport, runtime, and argument metadata.
 */

import * as fs from 'fs';
import type {
  RegistryType,
  RegistryConfig,
  McpServerEntry,
  McpRegistryResponse,
  SkillEntry,
  RegistrySearchResult,
  ResolvedPackage,
} from './types.js';
import { DEFAULT_REGISTRIES } from './types.js';
import { readMeta, writeMeta } from './state.js';

const UNSAFE_PACKAGE_SPEC_CHARS = /[;&|`$\s\x00-\x1f\x7f]/;
const NPM_SPEC_PATTERN = /^(@[a-z0-9][a-z0-9-_.]*\/)?[a-z0-9][a-z0-9-_.]*(@[A-Za-z0-9._+-]+)?$/;
const PYPI_SPEC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,_-]+\])?(==[A-Za-z0-9._-]+)?$/;

export function validatedNpmSpec(spec: string): string {
  if (spec.length > 214 || UNSAFE_PACKAGE_SPEC_CHARS.test(spec) || !NPM_SPEC_PATTERN.test(spec)) {
    throw new Error(`Invalid npm package spec: ${spec}`);
  }
  return spec;
}

export function validatedPyPISpec(spec: string): string {
  if (UNSAFE_PACKAGE_SPEC_CHARS.test(spec) || !PYPI_SPEC_PATTERN.test(spec)) {
    throw new Error(`Invalid PyPI package spec: ${spec}`);
  }
  return spec;
}

/** Get all registries of a given type, merging defaults with user overrides. */
export function getRegistries(type: RegistryType): Record<string, RegistryConfig> {
  const meta = readMeta();
  const defaultRegs = DEFAULT_REGISTRIES[type] || {};
  const userRegs = meta.registries?.[type] || {};

  // Merge defaults with user config (user overrides defaults)
  return { ...defaultRegs, ...userRegs };
}

/** Get only the enabled registries of a given type. */
export function getEnabledRegistries(type: RegistryType): Array<{ name: string; config: RegistryConfig }> {
  const registries = getRegistries(type);
  return Object.entries(registries)
    .filter(([, config]) => config.enabled)
    .map(([name, config]) => ({ name, config }));
}

/** Add or update a registry configuration in agents.yaml. */
export function setRegistry(
  type: RegistryType,
  name: string,
  config: Partial<RegistryConfig>
): void {
  const meta = readMeta();
  if (!meta.registries) {
    meta.registries = { mcp: {}, skill: {} };
  }
  if (!meta.registries[type]) {
    meta.registries[type] = {};
  }

  const existing = meta.registries[type][name] || DEFAULT_REGISTRIES[type]?.[name];
  meta.registries[type][name] = { ...existing, ...config } as RegistryConfig;
  writeMeta(meta);
}

/** Remove a user-configured registry. Returns false if it did not exist. */
export function removeRegistry(type: RegistryType, name: string): boolean {
  const meta = readMeta();
  if (meta.registries?.[type]?.[name]) {
    delete meta.registries[type][name];
    writeMeta(meta);
    return true;
  }
  return false;
}

/**
 * Cap every registry network call. Without this a slow or unreachable registry
 * hangs the calling command indefinitely (`agents add`, `agents mcp`, package
 * resolution) — and makes CI flake when the registry is unreachable. On timeout
 * the fetch aborts, callers fall back to their git/no-match path.
 */
const REGISTRY_FETCH_TIMEOUT_MS = 8000;

async function fetchMcpRegistry(
  url: string,
  query?: string,
  limit: number = 20,
  apiKey?: string
): Promise<McpRegistryResponse> {
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  params.set('limit', String(limit));

  const fullUrl = `${url}/servers?${params}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(fullUrl, {
    headers,
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Registry request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<McpRegistryResponse>;
}

/** Search MCP registries for servers matching a query string. */
export async function searchMcpRegistries(
  query: string,
  options?: { registry?: string; limit?: number }
): Promise<RegistrySearchResult[]> {
  const registries = getEnabledRegistries('mcp');
  const results: RegistrySearchResult[] = [];

  const targetRegistries = options?.registry
    ? registries.filter((r) => r.name === options.registry)
    : registries;

  if (targetRegistries.length === 0) {
    if (options?.registry) {
      throw new Error(`Registry '${options.registry}' not found or not enabled`);
    }
    return [];
  }

  for (const { name, config } of targetRegistries) {
    try {
      const response = await fetchMcpRegistry(
        config.url,
        query,
        options?.limit || 20,
        config.apiKey
      );

      for (const { server } of response.servers) {
        results.push({
          name: server.name,
          description: server.description,
          type: 'mcp',
          source: server.repository?.url || server.name,
          registry: name,
          version: server.version_detail?.version,
        });
      }
    } catch (err) {
      // Log but continue with other registries
      console.error(`Failed to search ${name}: ${(err as Error).message}`);
    }
  }

  return results;
}

/**
 * Convert an MCP server registry entry into an install spec suitable for
 * writing into `manifest.mcp`. Returns `null` if the entry has no package we
 * know how to launch (e.g. only remote endpoints, which the current manifest
 * shape supports via `url`+`transport: 'http'` but isn't yet wired to the
 * registry's `remotes` field).
 *
 * Supported package shapes:
 *   - npm / runtime=node      → `npx -y <name>`
 *   - pypi / runtime=python   → `uvx <name>`
 *   - runtime=docker          → `docker run --rm -i <name>`
 *   - runtime=binary          → `<name>` (assumed to be on PATH)
 */
export function mcpEntryToInstallSpec(
  entry: McpServerEntry
): { command?: string; url?: string; transport: 'stdio' | 'http' } | null {
  const pkg = entry.packages?.[0];
  if (!pkg) return null;

  // Remote transports (sse / streamable-http) need a URL the registry doesn't
  // currently expose in this client's type. Skip for now; caller can fall back
  // to manual --transport http with an explicit URL.
  if (pkg.transport === 'sse' || pkg.transport === 'streamable-http') {
    return null;
  }

  const reg = pkg.registry_name?.toLowerCase();
  const runtime = pkg.runtime;
  const name = pkg.name;

  if (!name) return null;

  if (reg === 'npm' || runtime === 'node') {
    return { command: `npx -y ${name}`, transport: 'stdio' };
  }
  if (reg === 'pypi' || runtime === 'python') {
    return { command: `uvx ${name}`, transport: 'stdio' };
  }
  if (runtime === 'docker') {
    return { command: `docker run --rm -i ${name}`, transport: 'stdio' };
  }
  if (runtime === 'binary') {
    return { command: name, transport: 'stdio' };
  }
  // Unknown registry/runtime — fall back to bare name so the user gets *something*
  // to inspect via `agents mcp view`, rather than a silent miss.
  return { command: name, transport: 'stdio' };
}

/** Look up detailed info for an MCP server by exact name. */
export async function getMcpServerInfo(
  serverName: string,
  registryName?: string
): Promise<McpServerEntry | null> {
  const registries = getEnabledRegistries('mcp');

  const targetRegistries = registryName
    ? registries.filter((r) => r.name === registryName)
    : registries;

  for (const { config } of targetRegistries) {
    try {
      // Search with exact name
      const response = await fetchMcpRegistry(config.url, serverName, 10, config.apiKey);

      // Find exact match
      const match = response.servers.find(
        ({ server }) =>
          server.name === serverName ||
          server.name.endsWith(`/${serverName}`)
      );

      if (match) {
        return match.server;
      }
    } catch {
      // Continue to next registry
    }
  }

  return null;
}

/** Raw shape of the skill index document served by Hermes and compatible registries. */
interface SkillIndexDocument {
  version?: number;
  generated_at?: string;
  skill_count?: number;
  skills: Array<{
    name: string;
    description?: string;
    source?: string;
    identifier?: string;
    trust_level?: string;
    repo?: string;
    path?: string;
    tags?: string[];
    author?: string;
    installs?: number;
  }>;
}

const skillIndexCache = new Map<string, { fetchedAt: number; doc: SkillIndexDocument }>();
const SKILL_INDEX_TTL_MS = 10 * 60_000;

/** Fetch and cache a flat skill-index JSON document. */
async function fetchSkillIndex(url: string, apiKey?: string): Promise<SkillIndexDocument> {
  const cached = skillIndexCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < SKILL_INDEX_TTL_MS) {
    return cached.doc;
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Registry request failed: ${response.status} ${response.statusText}`);
  }

  const doc = (await response.json()) as SkillIndexDocument;
  skillIndexCache.set(url, { fetchedAt: Date.now(), doc });
  return doc;
}

/** Map a raw skill-index row into the canonical SkillEntry shape. */
function normalizeSkillEntry(raw: SkillIndexDocument['skills'][number]): SkillEntry {
  return {
    name: raw.name,
    description: raw.description,
    source: raw.source || 'unknown',
    identifier: raw.identifier,
    repo: raw.repo || undefined,
    path: raw.path || undefined,
    author: raw.author,
    installs: raw.installs,
    tags: raw.tags,
    trustLevel: raw.trust_level,
  };
}

/** Case-insensitive substring match against the fields users expect to search. */
function skillMatchesQuery(entry: SkillEntry, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [
    entry.name,
    entry.identifier,
    entry.description,
    entry.source,
    ...(entry.tags || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Search skill registries for entries matching a query string. */
export async function searchSkillRegistries(
  query: string,
  options?: { registry?: string; limit?: number }
): Promise<RegistrySearchResult[]> {
  const registries = getEnabledRegistries('skill');
  if (registries.length === 0) return [];

  const targetRegistries = options?.registry
    ? registries.filter((r) => r.name === options.registry)
    : registries;

  if (targetRegistries.length === 0) {
    if (options?.registry) {
      throw new Error(`Registry '${options.registry}' not found or not enabled`);
    }
    return [];
  }

  const limit = options?.limit ?? 20;
  const results: RegistrySearchResult[] = [];

  for (const { name, config } of targetRegistries) {
    try {
      const doc = await fetchSkillIndex(config.url, config.apiKey);
      for (const raw of doc.skills || []) {
        const entry = normalizeSkillEntry(raw);
        if (!skillMatchesQuery(entry, query)) continue;
        results.push({
          name: entry.identifier || entry.name,
          description: entry.description,
          type: 'skill',
          source: entry.source,
          registry: name,
          installs: entry.installs,
        });
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    } catch (err) {
      console.error(`Failed to search ${name}: ${(err as Error).message}`);
    }
  }

  return results;
}

/** Look up a skill by identifier (or name) across enabled skill registries. */
export async function getSkillEntry(
  skillIdentifier: string,
  registryName?: string
): Promise<SkillEntry | null> {
  const registries = getEnabledRegistries('skill');
  const targets = registryName
    ? registries.filter((r) => r.name === registryName)
    : registries;

  for (const { config } of targets) {
    try {
      const doc = await fetchSkillIndex(config.url, config.apiKey);
      const match = (doc.skills || []).find(
        (s) => s.identifier === skillIdentifier || s.name === skillIdentifier
      );
      if (match) return normalizeSkillEntry(match);
    } catch {
      /* try next registry */
    }
  }
  return null;
}

/** Derive a cloneable git source from a skill entry's repo/source metadata. */
export function skillEntryToGitSource(entry: SkillEntry): string | null {
  if (entry.repo) {
    // Already an owner/repo; cloneRepo understands the `gh:` shorthand.
    return `gh:${entry.repo.replace(/\.git$/, '')}`;
  }
  if (entry.source === 'official') {
    // Hermes 'official' entries live in NousResearch/hermes-agent; the path
    // sits under optional-skills/. cloneRepo pulls the whole repo — the
    // per-path narrowing is a follow-on improvement.
    return 'gh:NousResearch/hermes-agent';
  }
  return null;
}

/** Unified search across all enabled registries of the specified type(s). */
export async function search(
  query: string,
  options?: { type?: RegistryType; registry?: string; limit?: number }
): Promise<RegistrySearchResult[]> {
  const results: RegistrySearchResult[] = [];

  if (!options?.type || options.type === 'mcp') {
    const mcpResults = await searchMcpRegistries(query, options);
    results.push(...mcpResults);
  }

  if (!options?.type || options.type === 'skill') {
    const skillResults = await searchSkillRegistries(query, options);
    results.push(...skillResults);
  }

  return results;
}

/** Parse a package identifier into its type (mcp, skill, git) and name. */
export function parsePackageIdentifier(identifier: string): {
  type: RegistryType | 'git' | 'unknown';
  name: string;
} {
  // mcp:filesystem -> MCP registry
  if (identifier.startsWith('mcp:')) {
    return { type: 'mcp', name: identifier.slice(4) };
  }

  // skill:user/repo -> skill registry (or git fallback)
  if (identifier.startsWith('skill:')) {
    return { type: 'skill', name: identifier.slice(6) };
  }

  // gh:user/repo -> git source
  if (identifier.startsWith('gh:')) {
    return { type: 'git', name: identifier };
  }

  // https://... or git@... -> git source
  if (identifier.startsWith('https://') || identifier.startsWith('git@')) {
    return { type: 'git', name: identifier };
  }

  // Local repo/path
  if (
    identifier.startsWith('/') ||
    identifier.startsWith('./') ||
    identifier.startsWith('../') ||
    fs.existsSync(identifier)
  ) {
    return { type: 'git', name: identifier };
  }

  // user/repo format -> could be either, need to search
  if (identifier.includes('/') && !identifier.includes(':')) {
    return { type: 'unknown', name: identifier };
  }

  // Single word -> search MCP registries first
  return { type: 'unknown', name: identifier };
}

/** Resolve a package identifier to an installable package with source metadata. */
export async function resolvePackage(identifier: string): Promise<ResolvedPackage | null> {
  const parsed = parsePackageIdentifier(identifier);

  if (parsed.type === 'git') {
    return { type: 'git', source: parsed.name };
  }

  if (parsed.type === 'mcp') {
    const entry = await getMcpServerInfo(parsed.name);
    if (entry) {
      return {
        type: 'mcp',
        source: entry.repository?.url || entry.name,
        mcpEntry: entry,
      };
    }
    return null;
  }

  if (parsed.type === 'skill') {
    const entry = await getSkillEntry(parsed.name);
    if (entry) {
      const gitSource = skillEntryToGitSource(entry);
      if (gitSource) {
        return {
          type: 'skill',
          source: gitSource,
          skillEntry: entry,
        };
      }
      // Entry found but has no installable repo (e.g. lobehub-only listings).
      return null;
    }
    // Fall back to git shorthand when the identifier isn't in any registry.
    const gitSource = parsed.name.startsWith('gh:') ? parsed.name : `gh:${parsed.name}`;
    return { type: 'git', source: gitSource };
  }

  // Unknown type - search registries
  if (parsed.type === 'unknown') {
    // Try MCP first
    const mcpEntry = await getMcpServerInfo(parsed.name);
    if (mcpEntry) {
      return {
        type: 'mcp',
        source: mcpEntry.repository?.url || mcpEntry.name,
        mcpEntry,
      };
    }

    // If it looks like a git path (user/repo), treat as git
    if (parsed.name.includes('/')) {
      return { type: 'git', source: `gh:${parsed.name}` };
    }
  }

  return null;
}
