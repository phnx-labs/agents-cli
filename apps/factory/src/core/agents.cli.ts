// SNAPSHOT of the agents-cli agent registry — id set and canonical metadata.
//
// Source of truth:
//   apps/cli/src/lib/types.ts   (the AgentId union)
//   apps/cli/src/lib/agents.ts  (the AGENTS table: name, cliCommand)
//
// The extension cannot import the CLI in-process (the repo has no JS
// workspaces; the CLI is ESM, the extension CommonJS), so the registry is
// mirrored here as a checked-in snapshot. agents.cli.test.ts reads the CLI
// source files from the monorepo and fails when this snapshot drifts, so an
// agent added to the CLI shows up here in the same change.
//
// Only VS Code presentation (title, icon, prefix, commandId) stays in
// core/agents.ts — everything an agent IS comes from this snapshot.

/** Every agent id the CLI supports (apps/cli/src/lib/types.ts AgentId). */
export const CLI_AGENT_IDS = [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'opencode',
  'openclaw',
  'copilot',
  'amp',
  'kiro',
  'goose',
  'antigravity',
  'grok',
  'kimi',
  'droid',
] as const;

/** Mirror of the CLI's AgentId union. */
export type CliAgentId = (typeof CLI_AGENT_IDS)[number];

export interface CliAgentMeta {
  /** Display name (AGENTS[id].name). */
  name: string;
  /** The binary the agent CLI installs as (AGENTS[id].cliCommand). */
  cliCommand: string;
}

/** Canonical per-agent metadata (apps/cli/src/lib/agents.ts AGENTS table). */
export const CLI_AGENT_META: Record<CliAgentId, CliAgentMeta> = {
  claude: { name: 'Claude', cliCommand: 'claude' },
  codex: { name: 'Codex', cliCommand: 'codex' },
  gemini: { name: 'Gemini', cliCommand: 'gemini' },
  cursor: { name: 'Cursor', cliCommand: 'cursor-agent' },
  opencode: { name: 'OpenCode', cliCommand: 'opencode' },
  openclaw: { name: 'OpenClaw', cliCommand: 'openclaw' },
  copilot: { name: 'Copilot', cliCommand: 'copilot' },
  amp: { name: 'Amp', cliCommand: 'amp' },
  kiro: { name: 'Kiro', cliCommand: 'kiro-cli' },
  goose: { name: 'Goose', cliCommand: 'goose' },
  antigravity: { name: 'Antigravity', cliCommand: 'agy' },
  grok: { name: 'Grok', cliCommand: 'grok' },
  kimi: { name: 'Kimi', cliCommand: 'kimi' },
  droid: { name: 'Droid', cliCommand: 'droid' },
};

/** Type guard against the CLI agent id set. */
export function isCliAgentId(value: string): value is CliAgentId {
  return (CLI_AGENT_IDS as readonly string[]).includes(value);
}
