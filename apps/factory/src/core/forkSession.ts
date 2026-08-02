import { STRATEGY_LAUNCH_AGENTS, type RunStrategy } from './agents';

export interface ForkSessionSource {
  sessionId?: string;
  agentKey?: string;
  host?: string;
}

export type ForkSessionRequest =
  | { ok: true; sessionId: string; agentKey: string; host?: string; local: boolean; strategy?: RunStrategy; prompt: string }
  | { ok: false; reason: 'no_session' | 'no_agent' };

export function strategyForForkAgent(agentKey: string): RunStrategy | undefined {
  return (STRATEGY_LAUNCH_AGENTS as readonly string[]).includes(agentKey) ? 'balanced' : undefined;
}

/** Build a sibling launch request without mutating or closing the source terminal. */
export function buildForkSessionRequest(source: ForkSessionSource): ForkSessionRequest {
  const sessionId = source.sessionId?.trim();
  if (!sessionId) return { ok: false, reason: 'no_session' };

  const agentKey = source.agentKey?.trim().toLowerCase();
  if (!agentKey) return { ok: false, reason: 'no_agent' };

  const host = source.host?.trim() || undefined;
  return {
    ok: true,
    sessionId,
    agentKey,
    host,
    local: !host,
    strategy: strategyForForkAgent(agentKey),
    prompt: `/continue ${sessionId}`,
  };
}
