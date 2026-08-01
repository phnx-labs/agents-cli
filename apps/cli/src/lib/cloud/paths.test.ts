import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { getUserAgentsDir, getCloudDir } from '../state.js';

// state.ts resolves its root as `process.env.HOME ?? os.homedir()`. On Windows
// HOME is unset, so mirror that exact resolution rather than asserting against a
// bare `process.env.HOME!` (which is `undefined` → `path.join` throws there).
const HOME = process.env.HOME ?? os.homedir();

describe('cloud path roots', () => {
  it('reads cloud config from ~/.agents/agents.yaml', async () => {
    const { getDefaultProviderId } = await import('./registry.js');
    expect(getDefaultProviderId()).toBeDefined();
    expect(path.join(getUserAgentsDir(), 'agents.yaml')).toBe(
      path.join(HOME, '.agents', 'agents.yaml'),
    );
  });

  it('stores cloud task state and consent under ~/.agents/.cache/cloud', () => {
    expect(path.join(getCloudDir(), 'tasks.db')).toBe(
      path.join(HOME, '.agents', '.cache', 'cloud', 'tasks.db'),
    );
    expect(path.join(getCloudDir(), 'rush-consent.json')).toBe(
      path.join(HOME, '.agents', '.cache', 'cloud', 'rush-consent.json'),
    );
  });
});
