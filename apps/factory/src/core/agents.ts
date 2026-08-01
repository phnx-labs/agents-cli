// Pure data and lookup functions (no VS Code dependencies - testable)
// VS Code-dependent functions are in agents.vscode.ts

import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  GEMINI_TITLE,
  OPENCODE_TITLE,
  CURSOR_TITLE,
  SHELL_TITLE,
  ANTIGRAVITY_TITLE,
  GROK_TITLE,
  KIMI_TITLE,
  DROID_TITLE
} from './utils';
import { CLI_AGENT_META, CliAgentId } from './agents.cli';

// Built-in agent definition (static data)
export interface BuiltInAgentDef {
  key: string;
  title: string;
  command: string;
  icon: string;
  prefix: string;
  commandId: string;
}

/**
 * The VS Code presentation overlay for each agent the extension offers a
 * spawn command for: tab title, icon asset, terminal prefix, and the
 * registered command id. What an agent IS — its id and launch binary — comes
 * from the CLI registry snapshot (agents.cli.ts, issue #741); 'shell' is the
 * one extension-only entry (a plain terminal, not a CLI agent).
 */
interface AgentPresentation {
  key: CliAgentId | 'shell';
  title: string;
  icon: string;
  prefix: string;
  commandId: string;
}

const PRESENTED_AGENTS: AgentPresentation[] = [
  { key: 'claude', title: CLAUDE_TITLE, icon: 'claude.png', prefix: 'cl', commandId: 'agents.newClaude' },
  { key: 'codex', title: CODEX_TITLE, icon: 'chatgpt.png', prefix: 'cx', commandId: 'agents.newCodex' },
  { key: 'gemini', title: GEMINI_TITLE, icon: 'gemini.png', prefix: 'gm', commandId: 'agents.newGemini' },
  { key: 'opencode', title: OPENCODE_TITLE, icon: 'opencode.png', prefix: 'oc', commandId: 'agents.newOpenCode' },
  { key: 'cursor', title: CURSOR_TITLE, icon: 'cursor.png', prefix: 'cr', commandId: 'agents.newCursor' },
  { key: 'shell', title: SHELL_TITLE, icon: 'agents.png', prefix: 'sh', commandId: 'agents.newShell' },
  { key: 'antigravity', title: ANTIGRAVITY_TITLE, icon: 'antigravity.png', prefix: 'ag', commandId: 'agents.newAntigravity' },
  { key: 'grok', title: GROK_TITLE, icon: 'grok.png', prefix: 'gk', commandId: 'agents.newGrok' },
  { key: 'kimi', title: KIMI_TITLE, icon: 'kimi.png', prefix: 'km', commandId: 'agents.newKimi' },
  { key: 'droid', title: DROID_TITLE, icon: 'droid.png', prefix: 'dr', commandId: 'agents.newDroid' }
];

export const BUILT_IN_AGENTS: BuiltInAgentDef[] = PRESENTED_AGENTS.map((p) => ({
  key: p.key,
  title: p.title,
  // The launch binary is the CLI registry's cliCommand — e.g. antigravity's is
  // `agy`, which the old hardcoded 'antigravity' entry got wrong.
  command: p.key === 'shell' ? '' : CLI_AGENT_META[p.key].cliCommand,
  icon: p.icon,
  prefix: p.prefix,
  commandId: p.commandId,
}));

// Lookup built-in agent by key (e.g., "claude", "codex")
export function getBuiltInByKey(key: string): BuiltInAgentDef | undefined {
  return BUILT_IN_AGENTS.find(a => a.key === key);
}

// Lookup built-in agent by prefix (e.g., "cl", "cx")
export function getBuiltInByPrefix(prefix: string): BuiltInAgentDef | undefined {
  return BUILT_IN_AGENTS.find(a => a.prefix === prefix);
}

// Lookup built-in agent by title (e.g., "CL", "CX")
export function getBuiltInDefByTitle(title: string): BuiltInAgentDef | undefined {
  return BUILT_IN_AGENTS.find(a => a.title === title);
}

// Dispatch "mode" the panel offers: Plan (read-only), Auto (the safe default —
// asks before anything risky), Edit (accepts edits without asking). We launch
// every agent through `agents run <agent>`, which has its OWN `--mode plan|auto|
// edit` flag and translates it to each CLI's native permission posture. So the
// flag is agent-AGNOSTIC — emitting the underlying `--permission-mode` directly
// would NOT reach the CLI (agents run only forwards raw native flags after a `--`
// separator), so Plan mode would silently fail to gate. `--mode <mode>` is the
// correct, supported flag for all agents.
export type AgentLaunchMode = 'plan' | 'auto' | 'edit';

const AGENTS_RUN_MODES: readonly AgentLaunchMode[] = ['plan', 'auto', 'edit'];

// Resolve the launch flag that puts an agent into `mode`. `agentKey` is accepted
// for call-site stability but not needed — `agents run --mode` is universal.
export function modeFlagForAgent(_agentKey: string, mode: AgentLaunchMode): string | undefined {
  return AGENTS_RUN_MODES.includes(mode) ? `--mode ${mode}` : undefined;
}

// ---- Plan detection (a Plan-mode Claude agent emits a plan) ----------------
// The CLI's session state engine (`state.ts`) captures the ExitPlanMode plan
// markdown and surfaces it as `session.plan` in `agents sessions <id> --json`.
// These pure helpers read the CLI JSON and turn the plan into the PendingPlan
// the Floor renders. Kept here (not in the VS Code layer) so they're
// unit-testable without a live session.

export interface PlanStepData { n: number; text: string }

// Extract the plan markdown from `agents sessions <id> --json` output. The CLI
// emits `{ session: { plan?: string, ... }, events: [...] }` — this reads
// `session.plan`, which the state engine populates from the LAST ExitPlanMode
// tool call at scan time (last one wins so a re-planned session surfaces its
// most recent plan). Returns null when no plan is present or the JSON is
// unparseable, matching the polling contract in watchForPlan.
export function extractPlanFromSessionJson(json: string): string | null {
  try {
    const parsed = JSON.parse(json);
    const plan = parsed?.session?.plan;
    return typeof plan === 'string' && plan.trim() ? plan : null;
  } catch {
    return null;
  }
}

// Split plan markdown into ordered steps. Prefers explicit list items
// (numbered `1.` / bulleted `-` / `*`), stripping the marker and any bold
// heading wrapper; falls back to non-empty, non-heading lines so a prose plan
// still yields steps. Renumbers sequentially so the Floor shows 1..N.
export function planTextToSteps(plan: string): PlanStepData[] {
  const lines = plan.split('\n').map(l => l.trim()).filter(Boolean);
  const listItems: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:\d+[.)]|[-*+])\s+(.*)$/);
    if (m && m[1].trim()) listItems.push(m[1].trim());
  }
  const source = listItems.length > 0
    ? listItems
    : lines.filter(l => !l.startsWith('#'));
  return source.map((text, i) => ({
    n: i + 1,
    // Drop surrounding markdown bold so a "**Step**: do x" reads cleanly.
    text: text.replace(/\*\*/g, '').trim(),
  }));
}

// Version/account selection strategy passed to `agents run --strategy`. Mirrors
// the agents-cli: pinned uses the configured default, balanced rotates across
// healthy accounts. The CLI ignores --strategy when an @version is pinned.
export type RunStrategy = 'pinned' | 'available' | 'balanced';

// Shell-quote a single token for safe interpolation into a `agents run …` shell
// string. Device names and user-supplied values are quoted defensively so a stray
// character can never break out of the command.
export function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Build the `agents run <agent> --interactive [--mode <m>] […]` shell string for
// an interactive terminal launch. `mode` defaults to `'auto'` when the caller
// does not specify one — auto is the writable-but-gated posture that lets an
// interactive agent edit files without stalling for read-only plan approval.
// Callers that need plan mode (e.g. a dispatch that explicitly wants planning)
// must pass `'plan'` explicitly.
export function buildAgentLaunchCommand(
  agentKey: string,
  sessionId: string | null,
  defaultModel?: string,
  additionalFlags?: string,
  pinnedVersion?: string,
  strategy?: RunStrategy,
  mode?: AgentLaunchMode,
  host?: string,
): string {
  const agentSpec = pinnedVersion ? `${agentKey}@${pinnedVersion}` : agentKey;
  let command = `agents run ${agentSpec} --interactive`;
  // Offload onto another machine over SSH — the CLI resolves the device from
  // `agents devices` and runs interactive-on-host. Emitted for ANY agent so
  // grok/kimi/droid (which launch as raw binaries locally) get host parity.
  if (host) {
    command += ` --host ${shquote(host)}`;
  }
  if (sessionId && agentKey === 'claude') {
    command += ` --session-id ${sessionId}`;
  }
  // --strategy is meaningless (and ignored by the CLI) once a version is
  // pinned, so only emit it for the unpinned, strategy-driven launches.
  if (strategy && !pinnedVersion) {
    command += ` --strategy ${strategy}`;
  }
  if (defaultModel && (!additionalFlags || !additionalFlags.includes('--model'))) {
    command += ` --model ${defaultModel}`;
  }
  // Dispatch mode -> `agents run --mode plan|auto|edit`, next to --model/--strategy.
  // Default to 'auto' when the caller has no preference — interactive Factory
  // launches must start in a writable posture so the agent can edit files.
  // Skip when the caller already threaded an explicit --mode via additionalFlags
  // so we never emit it twice.
  const effectiveMode: AgentLaunchMode = mode ?? 'auto';
  const modeFlag = modeFlagForAgent(agentKey, effectiveMode);
  if (modeFlag && (!additionalFlags || !additionalFlags.includes('--mode'))) {
    command += ` ${modeFlag}`;
  }
  if (additionalFlags?.trim()) {
    command += ` ${additionalFlags.trim()}`;
  }
  return command;
}

/**
 * Wrap a native-mode agent launch command with `exec` so the shell process is
 * replaced by the agent runner. When the runner exits the terminal process exits
 * too, which causes VS Code to close the tab automatically — mirroring the
 * pane-died behaviour tmux mode already has.
 *
 * Shell tabs must NOT be exec-prefixed: the user drives them interactively and
 * keeping the parent shell alive is the expected behaviour.
 */
export function wrapNativeAgentCommand(command: string, isShell: boolean): string {
  if (!command || isShell) return command;
  return `exec ${command}`;
}

// Agents that expose the per-strategy launch trio (Latest / Balanced / Pinned).
// These are the version- and account-managed agents that route through
// `agents run <agent>` so the agents-cli can apply a version pin or strategy.
export const STRATEGY_LAUNCH_AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'antigravity'] as const;

// Compare two dotted version strings (e.g. "2.1.170" vs "2.1.42") numerically.
// Returns >0 when a is newer, <0 when b is newer, 0 when equal. Non-numeric
// segments sort below numeric ones so prerelease tags lose to plain releases.
function compareVersions(a: string, b: string): number {
  const segA = a.split('.');
  const segB = b.split('.');
  const len = Math.max(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(segA[i] ?? '', 10);
    const nb = parseInt(segB[i] ?? '', 10);
    const aIsNum = !Number.isNaN(na);
    const bIsNum = !Number.isNaN(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
    } else if (aIsNum !== bIsNum) {
      // A numeric segment outranks a missing/non-numeric one.
      return aIsNum ? 1 : -1;
    }
    // Both non-numeric at this position: treat as equal, keep scanning.
  }
  return 0;
}

// Pick the newest installed version from a list of version strings. Entries
// without a leading numeric segment (profiles like "yosemite", "test-proxy")
// are ignored so they never win "Latest". Returns undefined when the list has
// no semver-shaped entry.
export function pickLatestVersion(versions: string[]): string | undefined {
  const semverish = versions.filter(v => !Number.isNaN(parseInt(v.split('.')[0] ?? '', 10)));
  if (semverish.length === 0) return undefined;
  return semverish.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}
