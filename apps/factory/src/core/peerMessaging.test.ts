import { describe, it, expect } from 'bun:test';
import {
  resolvePeerMessage,
  PEER_MESSAGE_MAX_CHARS,
  type PeerTerminal,
} from './peerMessaging';

const sessionA = 'a1b2c3d4-e5f6-7890-1234-aaaaaaaaaaaa';
const sessionB = 'b1b2c3d4-e5f6-7890-1234-bbbbbbbbbbbb';
const sessionC = 'c1b2c3d4-e5f6-7890-1234-cccccccccccc';

const terminals: PeerTerminal[] = [
  { id: 'CC-1', sessionId: sessionA, agentType: 'claude' },
  { id: 'CX-1', sessionId: sessionB, agentType: 'codex' },
  { id: 'GX-1', sessionId: sessionC, agentType: 'gemini' },
];

describe('resolvePeerMessage', () => {
  it('rejects empty text after trim', () => {
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: sessionA,
      targetSessionId: sessionB,
      text: '   \n  ',
    });
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.error).toBe('Text cannot be empty');
  });

  it('rejects text over the max character cap', () => {
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: sessionA,
      targetSessionId: sessionB,
      text: 'x'.repeat(PEER_MESSAGE_MAX_CHARS + 1),
    });
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.error).toContain('under 2000');
  });

  it('accepts text exactly at the cap', () => {
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: sessionA,
      targetSessionId: sessionB,
      text: 'x'.repeat(PEER_MESSAGE_MAX_CHARS),
    });
    expect(r.kind).toBe('ok');
  });

  it('rejects self-send when sender equals target verbatim', () => {
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: sessionA,
      targetSessionId: sessionA,
      text: 'note to self',
    });
    expect(r.kind).toBe('self-send');
  });

  it('rejects self-send detected after partial-match lookup', () => {
    // Caller passes their own truncated id as the target.
    const truncated = sessionA.slice(0, 8);
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: sessionA,
      targetSessionId: truncated,
      text: 'note to self via prefix',
    });
    expect(r.kind).toBe('self-send');
  });

  it('returns ok on exact sessionId match', () => {
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: sessionA,
      targetSessionId: sessionB,
      text: '  hand off the build  ',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.terminal.id).toBe('CX-1');
      expect(r.trimmedText).toBe('hand off the build');
    }
  });

  it('returns ok on prefix match (terminal sessionId starts with target)', () => {
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: sessionA,
      targetSessionId: sessionB.slice(0, 8),
      text: 'hi',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.terminal.id).toBe('CX-1');
  });

  it('returns ok on prefix match (target starts with terminal sessionId)', () => {
    // A terminal in the registry has a shorter id than what the caller
    // supplied (e.g., the caller saw a longer canonical form somewhere).
    const shortRegistry: PeerTerminal[] = [
      { id: 'CC-short', sessionId: 'a1b2c3d4', agentType: 'claude' },
    ];
    const r = resolvePeerMessage({
      terminals: shortRegistry,
      senderSessionId: sessionB,
      targetSessionId: sessionA,
      text: 'hi',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.terminal.id).toBe('CC-short');
  });

  it('returns not-found when no terminal matches', () => {
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: sessionA,
      targetSessionId: 'no-such-session',
      text: 'hi',
    });
    expect(r.kind).toBe('not-found');
    if (r.kind === 'not-found') expect(r.error).toContain('no-such-session');
  });

  it('skips self-send guard when sender has no sessionId', () => {
    // Smart-watchdog one-shot — has no AGENT_SESSION_ID env, so MCP sends ''.
    // We must NOT reject — sender is unknown, not "myself".
    const r = resolvePeerMessage({
      terminals,
      senderSessionId: '',
      targetSessionId: sessionA,
      text: 'hi',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.terminal.id).toBe('CC-1');
  });
});
