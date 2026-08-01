import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate HOME so resolveVersion finds no default — must run before importing
// the module under test (which resolves paths from HOME at call time).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-test-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { execShimPassthrough } = await import('./exec.js');

describe('execShimPassthrough', () => {
  it('returns 127 without spawning when the agent has no installed default', async () => {
    // No ~/.agents/agents.yaml and no installed versions in TEST_HOME, so the
    // version guard short-circuits before any process is spawned. This is the
    // path the generated Windows .cmd shim hits when nothing is set up yet.
    const code = await execShimPassthrough('claude', [], TEST_HOME);
    expect(code).toBe(127);
  });
});
