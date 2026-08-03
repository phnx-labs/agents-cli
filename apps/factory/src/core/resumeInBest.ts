// Pure logic for picking the best-available agent version to resume a session
// into. Consumes the shape emitted by `agents view <agent> --json` (agents-cli
// >= 1.13.0). Lives in core/ so it can be unit-tested without VS Code.

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

function statusRank(status: AgentsViewJsonVersion['usageStatus']): number {
  if (status === 'available') return 0;
  if (status === 'rate_limited' || status === null) return 1;
  return 2; // out_of_credits
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
 * Build the shell command that launches the target agent version. For Claude
 * we pin the session id via `--session-id <uuid>` so the jsonl appears at a
 * predictable path — lets `armAgentReady` fs.watch fire at the exact moment
 * the TUI is live instead of guessing from process state. Other agents don't
 * support the flag today; newSessionId is ignored for them.
 */
export function buildLaunchCommand(
  agentBinary: string,
  version: string,
  agentKey: string,
  newSessionId: string | null
): string {
  const base = `${agentBinary}@${version}`;
  if (agentKey === 'claude' && newSessionId) {
    return `${base} --session-id ${newSessionId}`;
  }
  return base;
}

/**
 * The same launch, but on the DEVICE the exhausted terminal was running on.
 *
 * Rotating an offloaded agent has to stay on its machine: the raw
 * `<binary>@<version>` form above would quietly move the work onto the laptop,
 * which is the opposite of what the rotate is for — the user offloaded it
 * deliberately, and the account that still has headroom is the one installed
 * over there.
 */
export function buildHostLaunchCommand(
  agentKey: string,
  version: string,
  host: string,
  newSessionId: string | null
): string {
  let cmd = `agents run ${agentKey}@${version} --interactive --host ${shellQuoteHost(host)}`;
  if (agentKey === 'claude' && newSessionId) {
    cmd += ` --session-id ${newSessionId}`;
  }
  return cmd;
}

/**
 * Launch a harness through `agents run` with NO version pin — the balanced
 * rotation picks the account. This is the `Agents: Resume (Pick Harness)`
 * launch: the user is switching harness, not account, so any healthy install
 * of the target harness will do. `claudeSessionId` pins the new Claude
 * session's id (same contract as {@link buildLaunchCommand}); ignored for
 * other harnesses.
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

/**
 * True when the caller's currently-pinned version is still good enough to
 * stay on — signed-in, not out_of_credits, and with session headroom left.
 *
 * Used by the Cmd+Shift+J flow to avoid an unnecessary profile switch when
 * the active terminal already sits on a usable version. The user's intent
 * with "pick the best" is really "pick *a* version that has usage" — any
 * usable version is acceptable, so there's no reason to re-spawn a terminal
 * at a different one.
 *
 * `undefined` input (version not tracked) returns false, so untagged
 * terminals fall back to the legacy "always switch" behavior.
 */
export function isVersionStillUsable(
  v: AgentsViewJsonVersion | undefined | null
): boolean {
  if (!v) return false;
  if (!v.signedIn) return false;
  if (v.usageStatus === 'out_of_credits') return false;
  if (sessionUsedPercent(v) >= 100) return false;
  return true;
}

/** The subset of a tracked terminal the rotate gate reads. */
export interface RotatableTerminal {
  agentType?: string;
  /** Version pinned at launch, when the caller pinned one. */
  version?: string;
  /** Version observed running, resolved from agents-cli metadata after spawn. */
  statusVersion?: string;
}

/**
 * The version an auto-rotate should judge for exhaustion, or undefined when this
 * terminal cannot rotate at all.
 *
 * Reading the PIN alone is what silently killed auto-rotate: launches stopped
 * pinning versions (balanced rotation picks the account), so `version` is now
 * usually empty and the gate skipped every terminal — an agent that hit its
 * limit just sat there. The version actually running is the one whose quota
 * matters, so the observed `statusVersion` counts too.
 *
 * Claude-only: it is the only harness whose accounts the rotate can swap
 * between (`--session-id` + `/continue`).
 */
export function rotatableVersionOf(entry: RotatableTerminal): string | undefined {
  if (entry.agentType !== 'claude') return undefined;
  return entry.version || entry.statusVersion || undefined;
}

/**
 * Pick the best signed-in version to resume into.
 *
 * Ranking:
 *   1. Must be signed-in.
 *   2. Prefer anything that is not out_of_credits (if every signed-in version
 *      is out_of_credits, fall through to the full list — better to resume
 *      somewhere than nowhere).
 *   3. Lowest 5-hour session usedPercent wins — that is the window that
 *      actually blocks the next turn.
 *   4. Tie-break on usageStatus (available > rate_limited > out_of_credits).
 *   5. Final tie-break on most recent lastActive.
 *
 * Returns null if no signed-in versions exist.
 */
export function pickBestVersion(
  versions: AgentsViewJsonVersion[]
): AgentsViewJsonVersion | null {
  const signedIn = versions.filter(v => v.signedIn);
  if (signedIn.length === 0) return null;

  const usable = signedIn.some(v => v.usageStatus !== 'out_of_credits')
    ? signedIn.filter(v => v.usageStatus !== 'out_of_credits')
    : signedIn;

  const sorted = [...usable].sort((a, b) => {
    const sa = sessionUsedPercent(a);
    const sb = sessionUsedPercent(b);
    if (sa !== sb) return sa - sb;
    const ra = statusRank(a.usageStatus);
    const rb = statusRank(b.usageStatus);
    if (ra !== rb) return ra - rb;
    const ta = a.lastActive ? Date.parse(a.lastActive) : 0;
    const tb = b.lastActive ? Date.parse(b.lastActive) : 0;
    return tb - ta;
  });

  return sorted[0] ?? null;
}
