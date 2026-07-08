/**
 * Unified resource system - exports all handlers and provides a registry.
 *
 * Usage:
 *   import { handlers, getHandler } from './resources/index.js';
 *   const cmds = handlers.commands.listAll('claude');
 */

export * from './types.js';

export { CommandsHandler, commandsHandler, type CommandItem } from './commands.js';
export { HooksHandler, type HookItem } from './hooks.js';
export { SkillsHandler, type SkillItem } from './skills.js';
export { RulesHandler, type RuleItem } from './rules.js';
export { McpHandler, getMcpConfigPath, type McpItem } from './mcp.js';
export { PermissionsHandler, type PermissionItem } from './permissions.js';
export { SubagentsHandler, subagentsHandler, type SubagentItem } from './subagents.js';
export { WorkflowsHandler, type WorkflowItem } from './workflows.js';

import { commandsHandler } from './commands.js';
import { HooksHandler } from './hooks.js';
import { SkillsHandler } from './skills.js';
import { RulesHandler } from './rules.js';
import { McpHandler } from './mcp.js';
import { PermissionsHandler } from './permissions.js';
import { subagentsHandler } from './subagents.js';
import { WorkflowsHandler } from './workflows.js';
import type { ResourceKind, ResourceHandler } from './types.js';

/** All resource handlers keyed by kind. */
export const handlers = {
  command: commandsHandler,
  commands: commandsHandler,
  hook: HooksHandler,
  hooks: HooksHandler,
  skill: SkillsHandler,
  skills: SkillsHandler,
  rule: RulesHandler,
  rules: RulesHandler,
  mcp: McpHandler,
  permission: PermissionsHandler,
  permissions: PermissionsHandler,
  subagent: subagentsHandler,
  subagents: subagentsHandler,
  workflow: WorkflowsHandler,
  workflows: WorkflowsHandler,
} as const;

/** Get a handler by resource kind. */
export function getHandler(kind: ResourceKind): ResourceHandler<unknown> | null {
  switch (kind) {
    case 'command':
      return commandsHandler;
    case 'hook':
      return HooksHandler;
    case 'skill':
      return SkillsHandler;
    case 'rule':
      return RulesHandler;
    case 'mcp':
      return McpHandler;
    case 'permission':
      return PermissionsHandler;
    case 'subagent':
      return subagentsHandler;
    case 'workflow':
      return WorkflowsHandler;
    default:
      return null;
  }
}

/** All resource kinds. */
export const RESOURCE_KINDS: ResourceKind[] = [
  'command',
  'hook',
  'skill',
  'rule',
  'mcp',
  'permission',
  'subagent',
  'workflow',
];
