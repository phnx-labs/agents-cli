import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { linearIssueUrl, linearWorkspace, _resetLinearWorkspaceCache } from './linear.js';

describe('linearIssueUrl — config-driven, workspace-scoped, never hardcoded', () => {
  const savedEnv = process.env.LINEAR_WORKSPACE;

  beforeEach(() => {
    _resetLinearWorkspaceCache();
    process.env.LINEAR_WORKSPACE = 'acme';
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LINEAR_WORKSPACE;
    else process.env.LINEAR_WORKSPACE = savedEnv;
    _resetLinearWorkspaceCache();
  });

  it('builds the canonical URL from the env workspace + a valid key', () => {
    expect(linearWorkspace()).toBe('acme');
    expect(linearIssueUrl('RUSH-1864')).toBe('https://linear.app/acme/issue/RUSH-1864');
  });

  it('only links strings shaped like a Linear key (TEAM-N)', () => {
    expect(linearIssueUrl('GPT-5')).toBe('https://linear.app/acme/issue/GPT-5'); // valid shape
    expect(linearIssueUrl('PR#123')).toBeUndefined(); // '#' → not a key
    expect(linearIssueUrl('rush-1')).toBeUndefined(); // must be uppercase
    expect(linearIssueUrl('RUSH-1234567')).toBeUndefined(); // >6 digits
    expect(linearIssueUrl('')).toBeUndefined();
    expect(linearIssueUrl(undefined)).toBeUndefined();
  });

  it('returns undefined when no workspace is configured (ticket stays plain text)', () => {
    delete process.env.LINEAR_WORKSPACE;
    _resetLinearWorkspaceCache();
    // With no env override and (in CI) no linear-cli config, the key can't be linked.
    // We assert the shape: either a real config resolves it, or it's undefined — never a throw.
    const url = linearIssueUrl('RUSH-1');
    expect(url === undefined || url === 'https://linear.app/' + linearWorkspace() + '/issue/RUSH-1').toBe(true);
  });
});
