// VS Code-dependent agent functions
// Pure logic is in agents.ts

import * as vscode from 'vscode';
import { getIconFilename } from '../core/utils';
import { BUILT_IN_AGENTS, BuiltInAgentDef } from '../core/agents';
import * as theme from './theme.vscode';

// Runtime agent configuration (requires VS Code types)
export interface AgentConfig {
  title: string;
  command: string;
  count: number;
  iconPath: vscode.IconPath;
  prefix: string;
}

// Create agent config with icon paths
export function createAgentConfig(
  extensionPath: string,
  title: string,
  command: string,
  icon: string,
  prefix: string
): Omit<AgentConfig, 'count'> {
  return {
    title,
    command,
    iconPath: theme.buildIconPath(extensionPath, icon),
    prefix
  };
}

// Lookup built-in agent by title and return full config with icon paths
export function getBuiltInByTitle(
  extensionPath: string,
  title: string
): Omit<AgentConfig, 'count'> | null {
  const def = BUILT_IN_AGENTS.find(a => a.title === title);
  if (!def) return null;
  return createAgentConfig(extensionPath, def.title, def.command, def.icon, def.prefix);
}

// Create agent config from a built-in definition
export function configFromDef(
  extensionPath: string,
  def: BuiltInAgentDef
): Omit<AgentConfig, 'count'> {
  return createAgentConfig(extensionPath, def.title, def.command, def.icon, def.prefix);
}

// Build icon path for a given prefix
export function buildIconPath(prefix: string, extensionPath: string): vscode.IconPath | null {
  const iconFile = getIconFilename(prefix);
  if (!iconFile) return null;
  return theme.buildIconPath(extensionPath, iconFile);
}
