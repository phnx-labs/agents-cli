// Pure functions for context file aliasing (no VS Code dependencies)

import { AgentsConfig, ContextMapping } from './swarmifyConfig';

// Legacy constants for backward compatibility
export const AGENTS_FILENAME = 'AGENTS.md';
export const AGENT_SYMLINK_TARGETS = ['CLAUDE.md', 'GEMINI.md', 'ANTIGRAVITY.md', 'GROK.md'] as const;

export type AgentSymlinkTarget = (typeof AGENT_SYMLINK_TARGETS)[number];

// Legacy functions for backward compatibility
export function isAgentsFileName(fileName: string): boolean {
  return fileName === AGENTS_FILENAME;
}

export function getSymlinkTargetsForFileName(fileName: string): AgentSymlinkTarget[] {
  return isAgentsFileName(fileName) ? [...AGENT_SYMLINK_TARGETS] : [];
}

export function getMissingTargets(
  candidates: readonly string[],
  existing: readonly string[]
): string[] {
  const existingSet = new Set(existing);
  return candidates.filter(name => !existingSet.has(name));
}

// Config-driven functions

// Get all context mappings from config
export function getContextMappings(config: AgentsConfig): ContextMapping[] {
  return config.context;
}

/** @deprecated Context files are always synced when aliases are defined */
export function isSymlinkingEnabled(_config: AgentsConfig): boolean {
  return true;
}
