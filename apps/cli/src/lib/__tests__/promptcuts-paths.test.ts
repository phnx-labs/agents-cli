/**
 * Promptcuts paths must resolve inside the hooks/ subdirectory of each repo,
 * not at the repo root. Promptcuts are data for the expand-promptcuts hook,
 * not a top-level resource type — co-located with the hook that consumes them.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import {
  getPromptcutsPath,
  getSystemPromptcutsPath,
  getUserPromptcutsPath,
} from '../state.js';

describe('promptcuts path resolution', () => {
  const home = os.homedir();

  it('system promptcuts file lives in ~/.agents/.system/hooks/', () => {
    expect(getSystemPromptcutsPath()).toBe(
      path.join(home, '.agents', '.system', 'hooks', 'promptcuts.yaml')
    );
  });

  it('user promptcuts file lives in ~/.agents/hooks/', () => {
    expect(getUserPromptcutsPath()).toBe(
      path.join(home, '.agents', 'hooks', 'promptcuts.yaml')
    );
  });

  it('legacy getPromptcutsPath returns the system path (back-compat)', () => {
    // Old callers relied on a single getPromptcutsPath() returning the
    // canonical location. After the refactor, the canonical location is the
    // system file inside hooks/.
    expect(getPromptcutsPath()).toBe(getSystemPromptcutsPath());
  });

  it('neither path is at the repo root anymore', () => {
    expect(getSystemPromptcutsPath()).not.toBe(
      path.join(home, '.agents', '.system', 'promptcuts.yaml')
    );
    expect(getUserPromptcutsPath()).not.toBe(
      path.join(home, '.agents', 'promptcuts.yaml')
    );
  });
});
