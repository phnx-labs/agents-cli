import { describe, expect, it } from 'vitest';
import { buildOpenClawNotifyArgs, formatUrgentBlockMessage } from './notify.js';

describe('buildOpenClawNotifyArgs (RUSH-1620)', () => {
  it('includes --target and --message (not --text)', () => {
    const args = buildOpenClawNotifyArgs('hello');
    expect(args).toEqual([
      'message',
      'send',
      '--channel',
      'telegram',
      '--account',
      'default',
      '--target',
      '6078999250',
      '--message',
      'hello',
    ]);
    expect(args).not.toContain('--text');
  });

  it('allows overriding target', () => {
    const args = buildOpenClawNotifyArgs('hi', { target: '123' });
    expect(args[args.indexOf('--target') + 1]).toBe('123');
  });
});

describe('formatUrgentBlockMessage', () => {
  it('formats urgent feed notifications without emoji', () => {
    const message = formatUrgentBlockMessage({
      blockId: 'block-a',
      sessionId: 'a',
      mailboxId: 'a',
      host: 'zion',
      runtime: 'headless',
      ts: '2026-07-21T12:00:00.000Z',
      blockClass: 'decision',
      costOfDelay: 'high',
      questions: [{ header: 'Deploy', text: 'Production deploy?' }],
    });

    expect(message).toBe('URGENT DECISION on zion: [Deploy] Production deploy? (cost: high, id: block-a)');
    expect(message).not.toContain(String.fromCodePoint(0x1f6a8));
  });
});
