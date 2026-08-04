// Shared logic for resuming sessions into agent terminals. Consumes the shape
// emitted by `agents view <agent> --json` (agents-cli >= 1.13.0) for the
// inventory/status surfaces, and builds the launch + /continue input for the
// resume flows. Lives in core/ so it can be unit-tested without VS Code.
//
// NOTE: version PICKING for rotations no longer lives here — the rotate path
// delegates host/harness/account selection to `agents run auto` (see
// core/autoRotate.ts, RUSH-2132).

export interface AgentsViewJsonVersion {
  version: string;
  isDefault: boolean;
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  windows: Array<{ key: string; usedPercent: number; resetsAt: string | null }>;
  lastActive: string | null;
  path: string;
}

export interface AgentsViewJsonAgent {
  agent: string;
  versions: AgentsViewJsonVersion[];
}

export function sessionUsedPercent(v: AgentsViewJsonVersion): number {
  const w = v.windows.find(w => w.key === 'session');
  return w ? w.usedPercent : 100;
}

/**
 * Convert the central `continue.md` body into a self-contained prompt for
 * versions that don't have the slash command synced to their home dir.
 * Strips the YAML frontmatter and substitutes `$ARGUMENTS` with the session
 * id. Callers prefix with a resume marker so the agent treats it as one
 * continuation task.
 */
export function inlineContinueInstructions(
  continueMdBody: string,
  sessionId: string
): string {
  const withoutFrontmatter = continueMdBody.replace(/^---[\s\S]*?\n---\s*\n/, '');
  return withoutFrontmatter.replace(/\$ARGUMENTS/g, sessionId).trim();
}

/**
 * Launch a harness through `agents run` with NO version pin — the balanced
 * rotation picks the account. This is the `Agents: Resume (Pick Harness)`
 * launch: the user is switching harness, not account, so any healthy install
 * of the target harness will do. `claudeSessionId` pins the new Claude
 * session's id; ignored for other harnesses.
 */
export function buildAgentRunLaunchCommand(
  agentKey: string,
  host?: string,
  claudeSessionId?: string | null,
): string {
  let cmd = `agents run ${agentKey} --interactive`;
  if (host) {
    cmd += ` --host ${shellQuoteHost(host)}`;
  }
  if (agentKey === 'claude' && claudeSessionId) {
    cmd += ` --session-id ${claudeSessionId}`;
  }
  return cmd;
}

/** Single-quote a device name so it can never break out of the built command. */
function shellQuoteHost(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the text the resume flow types into the agent's TUI prompt to make
 * it load the OLD session's transcript. Prefers the `/continue` slash
 * command when it's synced to the target version's home; falls back to the
 * inlined body of the central continue.md; last resort is a terse
 * instruction string.
 */
export function buildResumeInput(
  oldSessionId: string,
  hasContinueCmd: boolean,
  centralContinueMdBody: string | null
): string {
  if (hasContinueCmd) {
    return `/continue ${oldSessionId}`;
  }
  if (centralContinueMdBody) {
    return inlineContinueInstructions(centralContinueMdBody, oldSessionId);
  }
  return `Resume previous work by loading session ${oldSessionId}. Run \`agents sessions ${oldSessionId}\` to load the transcript, assess current state, then continue working.`;
}
