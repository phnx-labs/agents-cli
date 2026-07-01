// Pure agent-spec resolution — the engine core. Takes a VersionProvider instead
// of touching the filesystem, so every branch is unit-testable with in-memory
// fixtures. Domain = installed versions (`add`/install use a separate npm path).
// Never calls process.exit; throws AgentSpecError on bad input.

import type { AgentId } from '../types.js';
import { AGENTS, ALL_AGENT_IDS, resolveAgentName, formatAgentError } from '../agents.js';
import { VERSION_RE } from './primitives.js';
import {
  AgentSpecError,
  type AgentTarget,
  type VersionProvider,
  type VersionSource,
  type ResolveOptions,
  type VersionFilter,
} from './types.js';

/**
 * Resolve an agent spec (single or comma-list) into concrete installed targets.
 * `@latest`/`@oldest`/`@all` range over installed versions.
 */
export function resolveAgentTargets(
  spec: string,
  provider: VersionProvider,
  opts: ResolveOptions = {},
): AgentTarget[] {
  const cwd = opts.cwd ?? process.cwd();
  const available = opts.availableAgents ?? ALL_AGENT_IDS;
  const onAmbiguous = opts.onAmbiguous ?? 'error';

  const rawEntries = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (rawEntries.length === 0) {
    throw new AgentSpecError('Empty agent spec.', 'empty');
  }

  // Expand the bare literal `all` (or `all@all`) into every available agent that
  // has ≥1 installed version. Lenient: agents with nothing installed are skipped.
  const entries: string[] = [];
  for (const e of rawEntries) {
    if (e === 'all' || e === 'all@all') {
      for (const a of available) {
        if (provider.listInstalled(a).length > 0) entries.push(`${a}@all`);
      }
    } else {
      entries.push(e);
    }
  }

  const out: AgentTarget[] = [];
  const seen = new Set<string>();
  const push = (agent: AgentId, version: string | null, source: VersionSource) => {
    const key = `${agent}@${version ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ agent, version, source });
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
        'missing-version',
      );
    }

    const agent = resolveAgentName(agentToken);
    if (!agent || !available.includes(agent)) {
      throw new AgentSpecError(formatAgentError(agentToken, [...available]), 'unknown-agent');
    }
    const name = AGENTS[agent].name;

    // ----- bare: project pin → global default → sole/ambiguous installed -----
    if (qualifier === null) {
      const proj = provider.getProjectVersion(agent, cwd);
      if (proj) { push(agent, proj, 'project-pin'); continue; }
      const glob = provider.getGlobalDefault(agent);
      if (glob) { push(agent, glob, 'global-default'); continue; }
      const installed = provider.listInstalled(agent);
      if (installed.length === 0) { push(agent, null, 'none'); continue; }
      if (installed.length === 1) { push(agent, installed[0], 'sole-installed'); continue; }
      if (onAmbiguous === 'newest') { push(agent, installed[installed.length - 1], 'newest-installed'); continue; }
      throw new AgentSpecError(
        `No default version set for ${name}. Specify one (${agent}@<version>) or set it: agents use ${agent}@<version>.`,
        'no-default', agent, installed,
      );
    }

    // ----- @pinned / @default: the configured global default -----
    if (qualifier === 'pinned' || qualifier === 'default') {
      const def = provider.getGlobalDefault(agent);
      if (!def) {
        throw new AgentSpecError(
          `No default version set for ${name}. Run: agents use ${agent}@<version>`,
          'no-default', agent, provider.listInstalled(agent),
        );
      }
      push(agent, def, 'global-default(@pinned)');
      continue;
    }

    // ----- @all: every installed version -----
    if (qualifier === 'all') {
      const installed = provider.listInstalled(agent);
      if (installed.length === 0) {
        throw new AgentSpecError(`No managed versions are installed for ${name}. Run: agents add ${agent}@latest`, 'none-installed', agent);
      }
      for (const v of installed) push(agent, v, 'explicit');
      continue;
    }

    // ----- @latest / @oldest: ends of the installed range -----
    if (qualifier === 'latest' || qualifier === 'oldest') {
      const installed = provider.listInstalled(agent);
      if (installed.length === 0) {
        throw new AgentSpecError(`No managed versions are installed for ${name}. Run: agents add ${agent}@latest`, 'none-installed', agent);
      }
      const isOldest = qualifier === 'oldest';
      push(agent, isOldest ? installed[0] : installed[installed.length - 1], isOldest ? 'alias-oldest' : 'alias-latest');
      continue;
    }

    // ----- exact version: validate then existence-check (no enumeration) -----
    if (!VERSION_RE.test(qualifier)) {
      throw new AgentSpecError(`Invalid version '${qualifier}' for ${name}. Allowed: latest or [A-Za-z0-9._+-]{1,64}.`, 'invalid-version', agent);
    }
    if (!provider.isInstalled(agent, qualifier)) {
      const installed = provider.listInstalled(agent);
      const hint = installed.length ? ` Installed: ${installed.join(', ')}.` : '';
      throw new AgentSpecError(`${name}@${qualifier} is not installed.${hint} Install it: agents add ${agent}@${qualifier}`, 'not-installed', agent, installed);
    }
    push(agent, qualifier, 'explicit');
  }

  return out;
}

/**
 * Single-target commands (`run`, `sync`, `inspect`): resolve a spec that must
 * name exactly one installed version. Rejects `@all` / multi-target specs.
 */
export function resolveSingleAgentTarget(
  spec: string,
  provider: VersionProvider,
  opts: ResolveOptions = {},
): { agent: AgentId; version: string; source: VersionSource } {
  const targets = resolveAgentTargets(spec, provider, opts);
  if (targets.length !== 1) {
    throw new AgentSpecError(`'${spec}' resolves to ${targets.length} targets; this command needs exactly one.`, 'multi-not-allowed');
  }
  const t = targets[0];
  if (t.version === null) {
    throw new AgentSpecError(`No installed version for ${AGENTS[t.agent].name}. Run: agents add ${t.agent}@latest`, 'none-installed', t.agent);
  }
  return { agent: t.agent, version: t.version, source: t.source };
}

/**
 * Read/list commands: resolve a qualifier into a version filter.
 *   undefined / '' / @any → no filter (show all installed versions)
 *   @default / @pinned    → the literal 'default' sentinel (show the configured default)
 *   @latest/@oldest/x.y.z → a concrete version (throws if not installed)
 * Uniform `@default` handling fixes the prior rules-vs-view inconsistency.
 */
export function resolveVersionFilter(
  agent: AgentId,
  qualifier: string | undefined | null,
  provider: VersionProvider,
  opts: ResolveOptions = {},
): VersionFilter {
  const q = qualifier?.trim();
  if (!q) return { version: null, source: 'all-versions' };
  if (q === 'default' || q === 'pinned') return { version: 'default', source: 'default' };
  if (q === 'any') return { version: null, source: 'all-versions' };
  const { version, source } = resolveSingleAgentTarget(`${agent}@${q}`, provider, { ...opts, availableAgents: [agent] });
  return { version, source };
}

/**
 * Concrete version filter for list/display commands whose downstream code
 * filters by an exact version string (not the `'default'` sentinel `view` uses).
 *   undefined / '' / @any → undefined  (no filter → show all installed)
 *   @default / @pinned    → the configured default version, or undefined if none
 *                           is set (falls back to show-all rather than erroring)
 *   @latest/@oldest/x.y.z → a concrete version (throws AgentSpecError if bad)
 */
export function resolveListFilter(
  agent: AgentId,
  qualifier: string | undefined | null,
  provider: VersionProvider,
  opts: ResolveOptions = {},
): string | undefined {
  const q = qualifier?.trim();
  if (!q || q === 'any') return undefined;
  if (q === 'default' || q === 'pinned') return provider.getGlobalDefault(agent) ?? undefined;
  return resolveSingleAgentTarget(`${agent}@${q}`, provider, { ...opts, availableAgents: [agent] }).version;
}
