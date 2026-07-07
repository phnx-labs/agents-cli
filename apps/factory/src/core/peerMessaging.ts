// Pure resolution logic for the `send_to_agent` MCP tool.
// Owns input validation, recipient lookup, and self-send detection.
// I/O (sendText, log append) lives in the bridge.

export interface PeerTerminal {
  id: string;
  sessionId?: string;
  agentType?: string;
}

export type PeerResolveResult =
  | { kind: 'invalid'; error: string }
  | { kind: 'self-send'; error: string }
  | { kind: 'not-found'; error: string }
  | { kind: 'ok'; terminal: PeerTerminal; trimmedText: string };

export interface ResolvePeerMessageArgs {
  terminals: PeerTerminal[];
  senderSessionId: string;
  targetSessionId: string;
  text: string;
}

export const PEER_MESSAGE_MAX_CHARS = 2000;

export function resolvePeerMessage(args: ResolvePeerMessageArgs): PeerResolveResult {
  const { terminals, senderSessionId, targetSessionId, text } = args;

  const trimmedText = text.trim();
  if (!trimmedText) {
    return { kind: 'invalid', error: 'Text cannot be empty' };
  }
  if (trimmedText.length > PEER_MESSAGE_MAX_CHARS) {
    return {
      kind: 'invalid',
      error: `Text must be under ${PEER_MESSAGE_MAX_CHARS} characters`,
    };
  }

  // Pre-lookup self-send guard. Only enforced when sender identified itself.
  // Smart-watchdog one-shots have no AGENT_SESSION_ID — they pass an empty
  // string here, and that case is fine.
  if (senderSessionId && senderSessionId === targetSessionId) {
    return { kind: 'self-send', error: 'Cannot send a message to your own session' };
  }

  const exact = terminals.find((t) => t.sessionId === targetSessionId);
  const recipient =
    exact ||
    terminals.find(
      (t) =>
        (t.sessionId && t.sessionId.startsWith(targetSessionId)) ||
        (t.sessionId && targetSessionId.startsWith(t.sessionId))
    );

  if (!recipient) {
    const active = terminals.map((t) => t.sessionId).filter(Boolean).join(', ');
    return {
      kind: 'not-found',
      error: `No terminal found for session ${targetSessionId}. Active sessions: ${active}`,
    };
  }

  // Post-lookup self-send guard: catches the case where the caller passed a
  // truncated targetSessionId that prefix-matched its own full session.
  if (senderSessionId && recipient.sessionId === senderSessionId) {
    return { kind: 'self-send', error: 'Cannot send a message to your own session' };
  }

  return { kind: 'ok', terminal: recipient, trimmedText };
}
