import { describe, it, expect } from 'bun:test';
import {
  decodeInjectQuery,
  selectInjectTarget,
  type InjectPayload,
  type InjectTerminal,
} from './inject';

// Encode a payload the way the agents-cli does: JSON -> base64url in the `p`
// param. This exercises the real decode path (no mocks).
function encode(payload: object): string {
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `?p=${p}`;
}

const sessionA = '4a78949e-1111-2222-3333-aaaaaaaaaaaa';
const sessionB = '5b89050f-4444-5555-6666-bbbbbbbbbbbb';

describe('decodeInjectQuery', () => {
  it('decodes a full base64url payload with all fields', () => {
    const query = encode({
      terminalId: sessionA,
      text: 'continue',
      enter: true,
      combined: false,
    });
    const p = decodeInjectQuery(query) as InjectPayload;
    expect(p).not.toBeNull();
    expect(p.terminalId).toBe(sessionA);
    expect(p.text).toBe('continue');
    expect(p.enter).toBe(true);
    expect(p.combined).toBe(false);
  });

  it('decodes when query has no leading question mark', () => {
    const withQ = encode({ terminalId: sessionA, text: 'hi' });
    const p = decodeInjectQuery(withQ.slice(1));
    expect(p?.terminalId).toBe(sessionA);
    expect(p?.text).toBe('hi');
  });

  it('defaults enter=true and combined=false when omitted', () => {
    const p = decodeInjectQuery(encode({ terminalId: sessionA, text: 'go' }));
    expect(p?.enter).toBe(true);
    expect(p?.combined).toBe(false);
  });

  it('preserves enter=false and combined=true', () => {
    const p = decodeInjectQuery(
      encode({ terminalId: sessionA, text: 'x', enter: false, combined: true })
    );
    expect(p?.enter).toBe(false);
    expect(p?.combined).toBe(true);
  });

  it('round-trips text with unicode and special chars through base64url', () => {
    const text = 'run the "build" && test — ¿listo? 你好';
    const p = decodeInjectQuery(encode({ terminalId: sessionA, text }));
    expect(p?.text).toBe(text);
  });

  it('accepts empty-string text (no submit-nothing guard here)', () => {
    const p = decodeInjectQuery(encode({ terminalId: sessionA, text: '' }));
    expect(p).not.toBeNull();
    expect(p?.text).toBe('');
  });

  it('returns null for empty query', () => {
    expect(decodeInjectQuery('')).toBeNull();
    expect(decodeInjectQuery('?')).toBeNull();
  });

  it('returns null when `p` param is absent', () => {
    expect(decodeInjectQuery('?terminalId=abc&text=hi')).toBeNull();
  });

  it('returns null for non-base64/garbage that fails JSON.parse', () => {
    expect(decodeInjectQuery('?p=not%20valid%20base64url!!!')).toBeNull();
  });

  it('returns null when decoded JSON is not an object', () => {
    const p = Buffer.from('"just a string"', 'utf8').toString('base64url');
    expect(decodeInjectQuery(`?p=${p}`)).toBeNull();
  });

  it('returns null when terminalId is missing or empty', () => {
    expect(decodeInjectQuery(encode({ text: 'hi' }))).toBeNull();
    expect(decodeInjectQuery(encode({ terminalId: '', text: 'hi' }))).toBeNull();
  });

  it('returns null when text is missing or non-string', () => {
    expect(decodeInjectQuery(encode({ terminalId: sessionA }))).toBeNull();
    expect(
      decodeInjectQuery(encode({ terminalId: sessionA, text: 123 }))
    ).toBeNull();
  });

  it('coerces non-boolean enter/combined to their defaults', () => {
    const p = decodeInjectQuery(
      encode({ terminalId: sessionA, text: 'go', enter: 'yes', combined: 1 })
    );
    expect(p?.enter).toBe(true);
    expect(p?.combined).toBe(false);
  });
});

describe('selectInjectTarget', () => {
  const terminals: InjectTerminal[] = [
    { id: 'CC-1', sessionId: sessionA },
    { id: 'CX-1', sessionId: sessionB },
    { id: 'SH-1' },
  ];

  it('selects by sessionId (the agents-cli case)', () => {
    expect(selectInjectTarget(terminals, sessionB)?.id).toBe('CX-1');
  });

  it('selects by internal terminal id', () => {
    expect(selectInjectTarget(terminals, 'CC-1')?.id).toBe('CC-1');
  });

  it('returns undefined when nothing matches', () => {
    expect(selectInjectTarget(terminals, 'no-such-id')).toBeUndefined();
  });

  it('does not match a terminal that has no sessionId against a session query', () => {
    expect(selectInjectTarget(terminals, 'undefined')).toBeUndefined();
  });
});
