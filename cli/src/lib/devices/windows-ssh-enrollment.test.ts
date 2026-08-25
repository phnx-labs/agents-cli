import { describe, expect, it } from 'vitest';
import { diagnoseWindowsSshFailure, parseWindowsSshEnrollment, windowsSshEnrollmentProblem } from './windows-ssh-enrollment.js';

const healthy = {
  administrator: true,
  expectedPath: 'C:\\ProgramData\\ssh\\administrators_authorized_keys',
  configuredPaths: ['__PROGRAMDATA__\\ssh\\administrators_authorized_keys'],
  fileExists: true,
  hasPublicKey: true,
  owner: 'BUILTIN\\Administrators',
  systemFullControl: true,
  administratorsFullControl: true,
  unexpectedAclPrincipals: [],
};

describe('Windows OpenSSH key enrollment diagnosis', () => {
  it('parses the exact PowerShell audit payload without exposing key contents', () => {
    const parsed = parseWindowsSshEnrollment(JSON.stringify(healthy));
    expect(parsed).toEqual(healthy);
    expect(JSON.stringify(parsed)).not.toContain('ssh-ed25519');
  });

  it('uses the ProgramData file for administrators and names missing ACL grants', () => {
    expect(windowsSshEnrollmentProblem({ status: { ...healthy, systemFullControl: false } })).toBe(
      'C:\\ProgramData\\ssh\\administrators_authorized_keys ACL must grant FullControl to SYSTEM and Administrators',
    );
  });

  it('uses the per-user file for normal accounts and diagnoses missing keys', () => {
    const status = {
      ...healthy,
      administrator: false,
      expectedPath: 'C:\\Users\\worker\\.ssh\\authorized_keys',
      configuredPaths: ['C:\\Users\\worker\\.ssh\\authorized_keys'],
      fileExists: false,
      hasPublicKey: false,
    };
    expect(windowsSshEnrollmentProblem({ status })).toBe('SSH public-key file missing: C:\\Users\\worker\\.ssh\\authorized_keys');
  });

  it('distinguishes effective-path, empty-file, and unexpected-ACL failures', () => {
    expect(windowsSshEnrollmentProblem({ status: { ...healthy, configuredPaths: ['.ssh\\authorized_keys'] } })).toMatch(/AuthorizedKeysFile resolves/);
    expect(windowsSshEnrollmentProblem({ status: { ...healthy, hasPublicKey: false } })).toMatch(/no public key enrolled/);
    expect(windowsSshEnrollmentProblem({ status: { ...healthy, unexpectedAclPrincipals: ['BUILTIN\\Users'] } })).toMatch(/unexpected principals: BUILTIN\\Users/);
  });

  it('distinguishes reachability, host-key, listener, and public-key rejection before login', () => {
    expect(diagnoseWindowsSshFailure('', true)).toMatch(/port 22 did not answer/);
    expect(diagnoseWindowsSshFailure('Host key verification failed.', false)).toMatch(/host-key verification failed/);
    expect(diagnoseWindowsSshFailure('connect to host win port 22: Connection refused', false)).toMatch(/not listening/);
    expect(diagnoseWindowsSshFailure('Permission denied (publickey,password).', false)).toMatch(/public key was rejected/);
  });
});
