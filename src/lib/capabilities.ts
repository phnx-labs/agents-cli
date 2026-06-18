/**
 * Capability gate for agent features.
 *
 * Every install path that touches an agent-version (hooks, plugins, MCP,
 * skills, commands) calls `supports(agent, cap, version?)` before writing to
 * the version's config dir. When the capability is unsupported or the version
 * is below `since`, the install path skips the write and surfaces a clear
 * reason instead of silently corrupting an older binary's settings file.
 */

import { AGENTS } from './agents.js';
import type {
  AgentId,
  Capability,
  CapabilityName,
  CapabilityResult,
  RulesCapability,
} from './types.js';

/**
 * Compare semver-like versions ("0.116.0" vs "0.115.9"). Local copy to avoid
 * importing versions.ts (which imports agents.ts, which imports this file).
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal !== bVal) return aVal - bVal;
  }
  return 0;
}

function getCapability(agent: AgentId, cap: CapabilityName): Capability | RulesCapability {
  // Guard against unknown agent ids (e.g. a caller passing "claude@2.1.168"
  // instead of "claude"). Without this, AGENTS[agent] is undefined and the
  // property access throws an opaque TypeError instead of reporting false.
  const def = AGENTS[agent];
  if (!def) return false;
  return def.capabilities[cap];
}

/**
 * True when the agent supports the capability on at least some version.
 * Useful for filtering UI lists; does not check installed version.
 */
export function isCapable(agent: AgentId, cap: CapabilityName): boolean {
  const c = getCapability(agent, cap);
  return c !== false;
}

/**
 * Check whether the given agent (optionally pinned to a specific installed
 * version) supports `cap`. Pass `version` whenever you know it -- omitting it
 * only checks the agent-level flag, which is fine for "is this agent ever
 * capable" filters but NOT for install-time gating.
 */
export function supports(
  agent: AgentId,
  cap: CapabilityName,
  version?: string
): CapabilityResult {
  const c = getCapability(agent, cap);
  if (c === false) return { ok: false, reason: 'unsupported' };
  if (c === true) return { ok: true };
  if ('file' in c) return { ok: true };

  if (!version) return { ok: true };

  if (c.since && compareVersions(version, c.since) < 0) {
    return { ok: false, reason: 'too_old', need: `>= ${c.since}` };
  }
  if (c.until && compareVersions(version, c.until) >= 0) {
    return { ok: false, reason: 'too_new', need: `< ${c.until}` };
  }
  return { ok: true };
}

/**
 * Human-readable explanation for skipping an install. Stable shape so callers
 * can either log it or push it onto an `errors[]` collector.
 */
export function explainSkip(
  agent: AgentId,
  cap: CapabilityName,
  result: CapabilityResult,
  version?: string
): string {
  if (result.ok) return '';
  const tag = version ? `${agent}@${version}` : agent;
  if (result.reason === 'unsupported') return `${tag}: ${cap} not supported`;
  return `${tag}: ${cap} requires ${result.need}`;
}

/** All agents whose `capabilities[cap]` is anything other than `false`. */
export function capableAgents(cap: CapabilityName): AgentId[] {
  return (Object.keys(AGENTS) as AgentId[]).filter((id) => isCapable(id, cap));
}
