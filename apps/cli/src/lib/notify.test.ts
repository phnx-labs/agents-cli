import { describe, expect, it } from 'vitest';
import { buildOpenClawNotifyArgs } from './notify.js';

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
