import { describe, expect, test } from 'bun:test';
import { parseSpawnRequest, resolveSpawnSurface } from './spawn';

// The `…/spawn` URI verb reopens a session as an editor tab. AGI EXT no longer
// spawns tmux-backed terminals at the extension level, so every request lands on
// a plain VS Code terminal surface.
describe('resolveSpawnSurface', () => {
  test('a plain spawn opens a new native tab', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: false, hasParent: false })
    ).toBe('native-tab');
  });

  test('a split beside a live parent uses a native split', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: true, hasParent: true })
    ).toBe('native-split');
  });

  test('a split request with no live parent falls back to a tab', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: true, hasParent: false })
    ).toBe('native-tab');
  });
});

describe('parseSpawnRequest', () => {
  function encode(obj: Record<string, unknown>): string {
    const p = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    return `p=${p}`;
  }

  test('parses command + cwd + split', () => {
    const req = parseSpawnRequest(encode({
      command: 'claude --resume abc',
      cwd: '/tmp/ws',
      split: 'right',
    }));
    expect(req).toEqual({
      command: 'claude --resume abc',
      cwd: '/tmp/ws',
      split: 'right',
      agent: undefined,
      sessionId: undefined,
      title: undefined,
    });
  });

  test('parses agent + sessionId + title for remote-attach chips (#2478)', () => {
    const req = parseSpawnRequest(encode({
      command: 'ssh -tt host tmux attach',
      cwd: '/Users/me/.agents',
      agent: 'Grok',
      sessionId: '115db661-1079-4e6b-846c-ce9aa05494f8',
      title: 'GK - restore',
    }));
    expect(req?.agent).toBe('grok'); // lowercased
    expect(req?.sessionId).toBe('115db661-1079-4e6b-846c-ce9aa05494f8');
    expect(req?.title).toBe('GK - restore');
    expect(req?.command).toContain('ssh');
  });

  test('returns null without a command', () => {
    expect(parseSpawnRequest(encode({ cwd: '/tmp' }))).toBeNull();
    expect(parseSpawnRequest('')).toBeNull();
  });
});
