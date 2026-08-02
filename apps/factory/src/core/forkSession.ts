export interface ForkSessionSource {
  sessionId?: string;
  agentKey?: string;
  host?: string;
}

export type ForkSessionRequest =
  | { ok: true; sessionId: string; agentKey: string; host?: string; prompt: string }
  | { ok: false; reason: 'no_session' | 'no_agent' };

/** Build the launch inputs for a divergent terminal without mutating the source. */
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
    prompt: `/continue ${sessionId}`,
  };
}
