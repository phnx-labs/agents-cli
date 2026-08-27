import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { attachAction, attachRecoveryArgs } from './attach.js';

describe('attachRecoveryArgs', () => {
  it('routes the whole attach action to the origin device', () => {
    expect(attachRecoveryArgs({ id: '14567b8a-db63-4e27-9867-4846813157cc' })).toEqual([
      'sessions',
      'attach',
      '14567b8a-db63-4e27-9867-4846813157cc',
    ]);
  });
});

describe('attachAction — the PHNX-3292 local gate wiring (real tmux socket, no mocking)', () => {
  it('a bare alias with no live local pane falls through to metadata resolution instead of hanging', async () => {
    // Random suffix: attachLocalLiveSelector reads the REAL default tmux
    // socket read-only (list-sessions / has-session), so this alias must be
    // one no genuinely live pane on the test machine will ever hold.
    const alias = `ag-claude-${randomBytes(4).toString('hex')}`;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await attachAction(alias);
      expect(errSpy.mock.calls.flat().join('\n')).toContain('No session matching');
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });
});
