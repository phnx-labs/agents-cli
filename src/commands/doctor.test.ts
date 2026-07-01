import { describe, it, expect } from 'vitest';
import { execPolicyWarningLines, wrapLine } from './doctor.js';
import { stringWidth } from '../lib/session/width.js';

describe('execPolicyWarningLines (Windows exec-policy advisory in `agents doctor`)', () => {
  it('fires when the policy blocks local scripts (Restricted) — with the RemoteSigned remediation', () => {
    const lines = execPolicyWarningLines('win32', 'Restricted');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('Restricted');
    // The remediation and the `.cmd` still-works note must both be surfaced.
    expect(lines.some((l) => l.includes('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'))).toBe(true);
    expect(lines.some((l) => l.includes('agents.cmd'))).toBe(true);
  });

  it('fires for AllSigned too', () => {
    expect(execPolicyWarningLines('win32', 'AllSigned').length).toBeGreaterThan(0);
  });

  it('stays silent for a permissive policy (RemoteSigned)', () => {
    expect(execPolicyWarningLines('win32', 'RemoteSigned')).toEqual([]);
  });

  it('stays silent when the policy can not be determined (null)', () => {
    expect(execPolicyWarningLines('win32', null)).toEqual([]);
  });

  it('never fires off Windows, even under a blocking policy', () => {
    expect(execPolicyWarningLines('linux', 'Restricted')).toEqual([]);
    expect(execPolicyWarningLines('darwin', 'AllSigned')).toEqual([]);
  });
});

describe('wrapLine', () => {
  it('wraps advisory text under its prefix', () => {
    const lines = wrapLine('  ', 'Reconcile with `agents doctor claude@latest --fix` or `agents sync claude@latest` (not applied on launch).', 62);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => stringWidth(line) <= 62)).toBe(true);
    expect(lines[1].startsWith('  ')).toBe(true);
  });

  it('collapses embedded newlines before wrapping', () => {
    expect(wrapLine('  ', 'one\n\n  two\tthree', 80)).toEqual(['  one two three']);
  });
});
