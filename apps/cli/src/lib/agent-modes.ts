/**
 * Permission-mode catalog for a harness.
 *
 * Source of truth is AGENTS[id].capabilities.modes plus the native CLI flags
 * in AGENT_COMMANDS.modeFlags. This is the modes analog of the model catalog
 * (`agents models`) — what a human or orchestrating agent reads before
 * `agents run <agent> --mode …` / `agents teams add … --mode …`.
 */

import type { AgentId, Mode } from './types.js';
import { ALL_MODES } from './types.js';
import { AGENTS } from './agents.js';
import { AGENT_COMMANDS, defaultModeFor } from './exec.js';
import { resolveRunDefaults } from './run-defaults.js';

/** Human description for each canonical permission mode. */
export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  plan: 'read-only investigation; no writes, no shell side-effects',
  edit: 'may edit files; prompts for shell / risky operations',
  auto: 'smart classifier auto-approves safe ops, prompts for risky',
  skip: 'bypass every permission prompt (dangerously-skip-permissions)',
};

export interface AgentModeEntry {
  mode: Mode;
  /** Native CLI flags agents-cli forwards for this mode (empty = harness default). */
  flags: string[];
  description: string;
  /** First entry in capabilities.modes — the safest native mode. */
  isDefault: boolean;
}

export interface AgentModesCatalog {
  agent: AgentId;
  /** Modes this harness natively supports, in declaration order. */
  modes: AgentModeEntry[];
  /** capabilities.modes[0] — safest native mode; run may still default elsewhere (e.g. CLI plan, teams edit). */
  defaultMode: Mode;
  /**
   * Configured run.defaults mode for this agent@version, when set.
   * Null means no pin — CLI default (plan for most harnesses) or modes[0] applies.
   */
  configuredMode: Mode | null;
  configuredModeSource: string | null;
  /**
   * Whether plan works in a headless (`-p` / prompt) run. false means a headless
   * --mode plan degrades (see resolveHeadlessMode). undefined = assumed true.
   */
  headlessPlan: boolean;
  /** Canonical modes this harness does NOT list in capabilities.modes. */
  unsupported: Mode[];
  /** Notes an orchestrator should read before picking a mode. */
  notes: string[];
}

/**
 * Build the permission-mode catalog for one harness.
 * `version` only affects the configured run.defaults lookup (modes themselves
 * are per-agent today, not version-gated).
 */
export function getAgentModesCatalog(
  agent: AgentId,
  version?: string | null,
  cwd: string = process.cwd(),
): AgentModesCatalog {
  const supported = AGENTS[agent].capabilities.modes;
  const defaultMode = defaultModeFor(agent);
  const modeFlags = AGENT_COMMANDS[agent]?.modeFlags ?? {};
  const headlessPlan = AGENTS[agent].capabilities.headlessPlan !== false;

  const modes: AgentModeEntry[] = supported.map((mode) => ({
    mode,
    flags: modeFlags[mode] ?? [],
    description: MODE_DESCRIPTIONS[mode],
    isDefault: mode === defaultMode,
  }));

  const unsupported = ALL_MODES.filter((m) => !supported.includes(m));

  const runDefaults = resolveRunDefaults(agent, version, cwd);
  const configuredMode = runDefaults.mode ?? null;
  const configuredModeSource = runDefaults.sources.mode ?? null;

  const notes: string[] = [];
  notes.push(`'full' is accepted as a silent alias for 'skip'.`);
  if (unsupported.includes('auto')) {
    notes.push(`--mode auto degrades to edit on ${agent} (no native auto classifier).`);
  }
  // MODE_DESCRIPTIONS is one flat Record<Mode, string>, so `auto` renders the
  // smart-classifier wording for every agent. Codex's auto has no classifier and
  // never prompts -- without this note the catalog an orchestrating agent reads
  // before `agents run codex --mode auto` asserts a gate that does not exist.
  if (agent === 'codex' && supported.includes('auto')) {
    notes.push(
      `codex --mode auto is approval_policy=never over the same sandbox as edit: it never prompts, and a sandbox-denied command fails instead of raising an approval request.`,
    );
  }
  if (unsupported.includes('plan')) {
    notes.push(`--mode plan degrades to ${defaultMode} on ${agent} (no native read-only mode).`);
  }
  if (!headlessPlan && supported.includes('plan')) {
    notes.push(
      `headless --mode plan is not supported on ${agent}; a prompt-based plan run auto-downgrades (see resolveHeadlessMode).`,
    );
  }
  if (unsupported.includes('skip')) {
    notes.push(`${agent} has no skip/full bypass mode.`);
  }

  return {
    agent,
    modes,
    defaultMode,
    configuredMode,
    configuredModeSource,
    headlessPlan,
    unsupported: [...unsupported],
    notes,
  };
}

/** Format native flags for display, e.g. `--permission-mode plan` or `(harness default)`. */
export function formatModeFlags(flags: string[]): string {
  if (flags.length === 0) return '(harness default)';
  return flags.join(' ');
}
