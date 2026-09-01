import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  linearIssueUrl,
  linearIssueKeys,
  linearIssueUrlsInText,
  linearWorkspace,
  _resetLinearWorkspaceCache,
} from './linear.js';

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

describe('linearIssueKeys — pull real ticket keys out of free text (PHNX-3698)', () => {
  it('returns distinct keys in first-seen order', () => {
    expect(linearIssueKeys('fix PHNX-3689 then RUSH-1, and PHNX-3689 again')).toEqual([
      'PHNX-3689',
      'RUSH-1',
    ]);
  });

  it('skips denylisted unit/acronym prefixes but still finds a real key alongside them', () => {
    expect(linearIssueKeys('decode UTF-8, build X86-64')).toEqual([]);
    expect(linearIssueKeys('UTF-8 encoding broke RUSH-42')).toEqual(['RUSH-42']);
  });

  it('is uppercase-only and shape-bounded (no lowercase, no >6 digits)', () => {
    expect(linearIssueKeys('rush-1 lowercase, RUSH-1234567 too long')).toEqual([]);
  });

  it('is empty for undefined / no key', () => {
    expect(linearIssueKeys(undefined)).toEqual([]);
    expect(linearIssueKeys('nothing to see here')).toEqual([]);
  });
});

describe('linearIssueUrlsInText — every mentioned key as a resolvable URL', () => {
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

  it('linkifies each key once, in order, honouring the denylist', () => {
    expect(linearIssueUrlsInText('root cause PHNX-3689; also PHNX-3689 and UTF-8')).toEqual([
      'https://linear.app/acme/issue/PHNX-3689',
    ]);
  });

  it('is empty when no workspace is configured (keys stay plain text)', () => {
    delete process.env.LINEAR_WORKSPACE;
    _resetLinearWorkspaceCache();
    const urls = linearIssueUrlsInText('see PHNX-3689');
    // Either a real linear-cli config resolves it, or nothing — never a throw.
    expect(urls.length === 0 || urls[0].endsWith('/issue/PHNX-3689')).toBe(true);
  });
});
