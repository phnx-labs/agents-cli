import { describe, it, expect } from 'vitest';
import { execPolicyWarningLines } from './doctor.js';

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
