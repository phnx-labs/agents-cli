// Pure functions for context file aliasing (no VS Code dependencies)

import { AgentsConfig, ContextMapping, getDefaultConfig } from './swarmifyConfig';

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

// Check if a filename is a source file in the config
export function isContextSourceFile(fileName: string, config: AgentsConfig): boolean {
  return config.context.some(c => c.source === fileName);
}

// Get all context mappings from config
export function getContextMappings(config: AgentsConfig): ContextMapping[] {
  return config.context;
}

// Get all source files from config
export function getSourceFiles(config: AgentsConfig): string[] {
  return config.context.map(c => c.source);
}

// Get aliases for a specific source file
export function getAliasesForSource(config: AgentsConfig, source: string): string[] {
  const mapping = config.context.find(c => c.source === source);
  return mapping ? mapping.aliases : [];
}

// --- Legacy compatibility aliases ---

/** @deprecated Use isContextSourceFile */
export function isMemorySourceFile(fileName: string, config: AgentsConfig): boolean {
  return isContextSourceFile(fileName, config);
}

/** @deprecated Use getContextMappings */
export function getFileMappings(config: AgentsConfig): ContextMapping[] {
  return config.context;
}

/** @deprecated Use getSourceFiles */
export function getPatternFiles(config: AgentsConfig): string[] {
  return config.context.map(c => c.source);
}

/** @deprecated Use getAliasesForSource */
export function getSymlinksForPattern(config: AgentsConfig, pattern: string): string[] {
  return getAliasesForSource(config, pattern);
}

/** @deprecated Context files are always synced when aliases are defined */
export function isSymlinkingEnabled(_config: AgentsConfig): boolean {
  return true;
}

export { getDefaultConfig };
