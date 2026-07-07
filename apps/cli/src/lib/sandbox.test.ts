
import { describe, it, expect } from 'vitest';
import { buildSpawnEnv } from './sandbox.js';
import { getUserAgentsDir } from './state.js';
import * as os from 'os';
import * as path from 'path';

describe('buildSpawnEnv', () => {
  it('sets HOME to the overlay and AGENTS_USER_DIR to the real user agents dir', () => {
    const overlayHome = path.join(os.tmpdir(), 'test-overlay-home');
    const env = buildSpawnEnv(overlayHome);
    
    expect(env.HOME).toBe(overlayHome);
    expect(env.AGENTS_USER_DIR).toBe(getUserAgentsDir());
  });

  it('preserves other allowlisted env vars', () => {
    // PATH is usually allowlisted
    if (process.env.PATH) {
      const env = buildSpawnEnv('/tmp/overlay');
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  it('allows extra env overrides', () => {
    const env = buildSpawnEnv('/tmp/overlay', { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });
});
