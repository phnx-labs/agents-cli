/**
 * Canonical list of resource kinds dispatched through the writer/detector
 * registry. Each name is the capability name on AgentConfig — except
 * "permissions", which maps to the legacy capability name "allowlist".
 */
import type { CapabilityName } from '../../types.js';

export type ResourceKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'permissions'
  | 'subagents'
  | 'plugins'
  | 'workflows';

export const ALL_RESOURCE_KINDS: readonly ResourceKind[] = [
  'commands',
  'skills',
  'hooks',
  'rules',
  'mcp',
  'permissions',
  'subagents',
  'plugins',
  'workflows',
] as const;

/** Map kind -> capability name on AgentConfig.capabilities. */
export function kindToCapability(kind: ResourceKind): CapabilityName {
  return kind === 'permissions' ? 'allowlist' : kind;
}
