import { describe, expect, it } from 'vitest';
import {
  buildSessionLifecycleArgs,
  isDirectResumeSelector,
  resolveResumePacking,
  resumeHostMismatch,
} from './sessions-resume.js';

describe('resolveResumePacking', () => {
  it('opens every resumed session in its own tab by default', () => {
    expect(resolveResumePacking({})).toBe('tabs');
  });

  it('packs session pairs into split panes only when requested', () => {
    expect(resolveResumePacking({ splits: true })).toBe('two-per-tab');
  });
});

describe('isDirectResumeSelector', () => {
  it('treats UUID prefixes and tmux aliases as direct identities', () => {
    expect(isDirectResumeSelector('019fd114')).toBe(true);
    expect(isDirectResumeSelector('ag-codex-c1f3d813')).toBe(true);
  });

  it('keeps human search text in the multi-select picker', () => {
    expect(isDirectResumeSelector('auth middleware')).toBe(false);
    expect(isDirectResumeSelector('claude@2.1.218')).toBe(false);
  });
});

describe('buildSessionLifecycleArgs', () => {
  it('routes an identity through focus and preserves source-device scope', () => {
    expect(buildSessionLifecycleArgs('ag-codex-c1f3d813', ['yosemite-s0'])).toEqual([
      'sessions', 'focus', 'ag-codex-c1f3d813', '--host', 'yosemite-s0',
    ]);
  });
});

describe('resumeHostMismatch', () => {
  it('accepts the indexed origin device', () => {
    expect(resumeHostMismatch({ shortId: 'abc12345', machine: 'yosemite-s0' }, 'yosemite-s0', 'zion')).toBeNull();
  });

  it('refuses to migrate recovery to another device', () => {
    expect(resumeHostMismatch({ shortId: 'abc12345', machine: 'yosemite-s0' }, 'zion', 'zion'))
      .toMatch(/originated on yosemite-s0.*cannot move recovery/);
  });
});
