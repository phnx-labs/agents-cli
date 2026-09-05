import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Fresh HOME before importing state/config (no summarizer configured → not ready).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-summ-state-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
delete process.env.AGENTS_SUMMARIZER_ENABLED;
delete process.env.AGENTS_SUMMARIZER_BASEURL;
delete process.env.AGENTS_SUMMARIZER_MODEL;

const { resolveStreamSummaryState } = await import('./session-cache.js');
const { resetSummarizerReadyCacheForTest } = await import('../summarizer/config.js');

describe('resolveStreamSummaryState (PHNX-3939 blocker)', () => {
  beforeEach(() => resetSummarizerReadyCacheForTest());

  it('passes through an already-resolved state', () => {
    expect(resolveStreamSummaryState('ready')).toBe('ready');
    expect(resolveStreamSummaryState('skipped')).toBe('skipped');
    expect(resolveStreamSummaryState('pending')).toBe('pending');
  });

  it('defaults to skipped when the summarizer is not ready (off OR enabled-but-unconfigured)', () => {
    // Nothing configured here — enabled-but-no-endpoint would compute nothing,
    // so an unset state must read `skipped`, never a `pending` that never resolves.
    expect(resolveStreamSummaryState(undefined)).toBe('skipped');
  });
});
