import { describe, expect, it } from 'vitest';

import { UNMANAGED_DETECTION_CANDIDATES } from '../agents.js';

describe('UNMANAGED_DETECTION_CANDIDATES', () => {
  it('includes copilot', () => {
    expect(UNMANAGED_DETECTION_CANDIDATES).toContain('copilot');
  });

  it('keeps the other first-class agents (regression guard)', () => {
    expect(UNMANAGED_DETECTION_CANDIDATES).toEqual(
      expect.arrayContaining(['claude', 'codex', 'gemini', 'grok'])
    );
  });
});
