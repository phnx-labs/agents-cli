// Centralized agent-spec resolution — one vocabulary, one resolver, reused by
// every subcommand that accepts `<agent>[@<qualifier>]`.
//
// The qualifier vocabulary used to be split across three functions in
// versions.ts (parseAgentSpec, resolveVersionAlias, resolveInstalledAgentTargets)
// with diverging support — `@latest`/`@oldest` in one, `@all`/`@default` in
// another, `@pinned` nowhere. This module is the single source of truth.
//
// Built for the hot path (`--launch`, ~100ms budget): the common specs resolve
// with NO directory enumeration —
//   exact `claude@2.1.181`   → one isVersionInstalled() (existsSync)
//   `claude@pinned|@default` → memoized getGlobalDefault() + existsSync
//   bare `claude`            → resolveVersion() (memoized meta), no readdir
// Only the relative qualifiers `@latest`/`@oldest`/`@all` enumerate, and even
// then via the mtime-cached listInstalledVersions().

import type { AgentId } from './types.js';
import { AGENTS, ALL_AGENT_IDS, resolveAgentName, formatAgentError } from './agents.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  isVersionInstalled,
  resolveVersion,
} from './versions.js';

export interface AgentTarget {
  agent: AgentId;
  /** Resolved exact version, or null when the agent has no installed versions yet. */
  version: string | null;
}

/** Canonical qualifier set, in help/display order. `pinned` ≡ `default`. */
export const AGENT_QUALIFIERS = ['latest', 'oldest', 'pinned', 'default', 'all'] as const;
export type AgentQualifier = (typeof AGENT_QUALIFIERS)[number];

/** Shared `--help` epilog so every agent-spec command documents the same grammar. */
export const AGENT_SPEC_HELP =
  'Agent spec: <agent>[@<qualifier>]. Qualifiers: ' +
  '@latest (highest installed), @oldest (lowest installed), ' +
  '@pinned / @default (your configured default — synonyms), ' +
  '@all (every installed version), or an exact @x.y.z. ' +
  'Bare <agent> uses the resolved default (project pin → global default). ' +
  'Comma-separate to combine: claude@all,codex@latest.';

export class AgentSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSpecError';
  }
}

export interface ResolveAgentTargetsOptions {
  /** Project dir for resolving a bare spec's project pin. Defaults to process.cwd(). */
  cwd?: string;
  /** Restrict the agents a spec may name (e.g. only mcp-capable). Defaults to all. */
  availableAgents?: readonly AgentId[];
}

/**
 * Resolve an agent spec (single or comma-list) into concrete installed targets.
 * Domain = installed: `@latest`/`@oldest`/`@all` range over installed versions
 * (`add`/`install` use a separate available-version path). Throws AgentSpecError
 * on bad input — never calls process.exit, so it is safe on the hot path and in
 * library contexts.
 */
export function resolveAgentTargets(
  spec: string,
  opts: ResolveAgentTargetsOptions = {},
): AgentTarget[] {
  const cwd = opts.cwd ?? process.cwd();
  const available = opts.availableAgents ?? ALL_AGENT_IDS;

  const rawEntries = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (rawEntries.length === 0) {
    throw new AgentSpecError('Empty agent spec.');
  }

  // Expand the bare literal `all` (or `all@all`) into every available agent that
  // has at least one installed version. Lenient: agents with nothing installed
  // are skipped rather than erroring.
  const entries: string[] = [];
  for (const e of rawEntries) {
    if (e === 'all' || e === 'all@all') {
      for (const a of available) {
        if (listInstalledVersions(a).length > 0) entries.push(`${a}@all`);
      }
    } else {
      entries.push(e);
    }
  }

  const out: AgentTarget[] = [];
  const seen = new Set<string>();
  const push = (agent: AgentId, version: string | null) => {
    const key = `${agent}@${version ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ agent, version });
    }
  };

  for (const entry of entries) {
    const at = entry.indexOf('@');
    const agentToken = (at === -1 ? entry : entry.slice(0, at)).trim();
    const qualifier = at === -1 ? null : entry.slice(at + 1).trim();

    if (!agentToken) continue;
    if (at !== -1 && !qualifier) {
      throw new AgentSpecError(
        `Missing version in '${entry}'. Use ${agentToken}@x.y.z, @latest, @oldest, @pinned, @default, or @all.`,
      );
    }

    const agent = resolveAgentName(agentToken);
    if (!agent || !available.includes(agent)) {
      throw new AgentSpecError(formatAgentError(agentToken, [...available]));
    }
    const name = AGENTS[agent].name;

    // ----- bare: resolved default, NO enumeration in the common case -----
    if (qualifier === null) {
      const resolved = resolveVersion(agent, cwd); // project pin → global default (meta-only)
      if (resolved) {
        push(agent, resolved);
      } else {
        const installed = listInstalledVersions(agent);
        if (installed.length === 0) push(agent, null);
        else if (installed.length === 1) push(agent, installed[0]);
        else
          throw new AgentSpecError(
            `No default version set for ${name}. Specify one (${agent}@<version>) or set it: agents use ${agent}@<version>.`,
          );
      }
      continue;
    }

    // ----- @pinned / @default: synonyms, meta-only fast path -----
    if (qualifier === 'pinned' || qualifier === 'default') {
      const def = getGlobalDefault(agent);
      if (!def) {
        throw new AgentSpecError(`No default version set for ${name}. Run: agents use ${agent}@<version>`);
      }
      push(agent, def);
      continue;
    }

    // ----- @all: every installed version -----
    if (qualifier === 'all') {
      const installed = listInstalledVersions(agent);
      if (installed.length === 0) {
        throw new AgentSpecError(`No managed versions are installed for ${name}. Run: agents add ${agent}@latest`);
      }
      for (const v of installed) push(agent, v);
      continue;
    }

    // ----- @latest / @oldest: enumerate (mtime-cached), pick an end -----
    if (qualifier === 'latest' || qualifier === 'oldest') {
      const installed = listInstalledVersions(agent); // already sorted ascending
      if (installed.length === 0) {
        throw new AgentSpecError(`No managed versions are installed for ${name}. Run: agents add ${agent}@latest`);
      }
      push(agent, qualifier === 'oldest' ? installed[0] : installed[installed.length - 1]);
      continue;
    }

    // ----- exact version: one existsSync, NO enumeration -----
    if (!isVersionInstalled(agent, qualifier)) {
      const installed = listInstalledVersions(agent);
      const hint = installed.length ? ` Installed: ${installed.join(', ')}.` : '';
      throw new AgentSpecError(`${name}@${qualifier} is not installed.${hint} Install it: agents add ${agent}@${qualifier}`);
    }
    push(agent, qualifier);
  }

  return out;
}

/**
 * Convenience for single-target commands (`use`, `run`): resolve a spec that
 * must name exactly one installed version. Rejects `@all` / multi-target specs.
 */
export function resolveSingleAgentTarget(
  spec: string,
  opts: ResolveAgentTargetsOptions = {},
): { agent: AgentId; version: string } {
  const targets = resolveAgentTargets(spec, opts);
  if (targets.length !== 1) {
    throw new AgentSpecError(`'${spec}' resolves to ${targets.length} targets; this command needs exactly one.`);
  }
  const t = targets[0];
  if (t.version === null) {
    throw new AgentSpecError(`No installed version for ${AGENTS[t.agent].name}. Run: agents add ${t.agent}@latest`);
  }
  return { agent: t.agent, version: t.version };
}
