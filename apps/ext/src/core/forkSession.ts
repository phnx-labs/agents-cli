import { isAgentRunner, type RunStrategy } from './agents';

export interface ForkSessionSource {
  sessionId?: string;
  agentKey?: string;
  /** Device the source session LIVES on; undefined means this machine. */
  host?: string;
  /** This machine's fleet name. Only read when a fork is moved off it. */
  localHost?: string;
}

/**
 * Where the user asked the fork to RUN, when they picked a device explicitly
 * (`Agents: Fork (Pick Host)`). `host: undefined` is a deliberate "run here";
 * passing no target at all leaves the fork on the source session's machine.
 */
export interface ForkSessionTarget {
  host?: string;
}

export type ForkSessionIntent = 'continue' | 'recap';

export type ForkSessionRequest =
  | {
      ok: true;
      sessionId: string;
      agentKey: string;
      /** Device the fork runs on; undefined = this machine. */
      host?: string;
      /** Device the source transcript lives on; undefined = this machine. */
      sourceHost?: string;
      /** True when the fork runs somewhere other than where the transcript lives. */
      moved: boolean;
      local: boolean;
      strategy?: RunStrategy;
      prompt: string;
    }
  | { ok: false; reason: 'no_session' | 'no_agent' };

export function strategyForForkAgent(agentKey: string): RunStrategy | undefined {
  // A fork is balanced like every other launch (apps/ext/AGENTS.md § "Launch
  // contract"). Only 'shell' — not an agent runner — carries no strategy.
  return isAgentRunner(agentKey) ? 'balanced' : undefined;
}

function sameMachine(a: string | undefined, b: string | undefined): boolean {
  return (a?.trim().toLowerCase() ?? '') === (b?.trim().toLowerCase() ?? '');
}

/**
 * The prompt the sibling agent starts with. Same machine: a bare `/continue`,
 * which resolves through that box's own index. Moved: a single-id lookup does
 * NOT fan out across the fleet — `agents sessions <id>` answers "No session with
 * id … on this machine" — so a fork that runs elsewhere has to be told where the
 * transcript is, and `--device <machine>` is the CLI's own recovery hint.
 */
function forkPrompt(sessionId: string, moved: boolean, sourceMachine: string | undefined): string {
  return moved && sourceMachine
    ? `/continue ${sessionId} --device ${sourceMachine}`
    : `/continue ${sessionId}`;
}

/**
 * Build a sibling launch request without mutating or closing the source terminal.
 *
 * With no `target` the fork runs where the session lives (the `Agents: Fork`
 * behavior). With a `target` the user has chosen the device, so that wins and the
 * request records the move — the harness and its balanced account rotation are
 * carried over untouched; only the machine changes.
 */
export function buildForkSessionRequest(
  source: ForkSessionSource,
  target?: ForkSessionTarget,
  intent: ForkSessionIntent = 'continue',
): ForkSessionRequest {
  const sessionId = source.sessionId?.trim();
  if (!sessionId) return { ok: false, reason: 'no_session' };

  const agentKey = source.agentKey?.trim().toLowerCase();
  if (!agentKey) return { ok: false, reason: 'no_agent' };

  const sourceHost = source.host?.trim() || undefined;
  const host = target ? target.host?.trim() || undefined : sourceHost;
  const moved = !sameMachine(host, sourceHost);
  // The transcript's machine as a name the fork can dial. A source on this box
  // carries no `host`, so a moved fork needs this machine's fleet name instead.
  const sourceMachine = sourceHost ?? source.localHost?.trim() ?? undefined;

  return {
    ok: true,
    sessionId,
    agentKey,
    host,
    sourceHost,
    moved,
    local: !host,
    strategy: strategyForForkAgent(agentKey),
    prompt: intent === 'recap'
      ? `/recap ${sessionId}`
      : forkPrompt(sessionId, moved, sourceMachine),
  };
}
