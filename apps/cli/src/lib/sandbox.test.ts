
import { describe, it, expect } from 'vitest';
import { buildSpawnEnv, getJobHomePath } from './sandbox.js';
import { getUserAgentsDir, getRoutinesDir } from './state.js';
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

  // RUSH-1016: sandboxed routine spawns must keep the daemon's headless Claude
  // OAuth token; without it the agent looks "unconfigured" under overlay HOME.
  it('forwards CLAUDE_CODE_OAUTH_TOKEN from the parent process', () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-token';
    try {
      const env = buildSpawnEnv('/tmp/overlay');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test-token');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    }
  });
});

describe('getJobHomePath — routine-name path containment (C4)', () => {
  const routinesDir = path.resolve(getRoutinesDir());

  it('returns a contained overlay path for a normal job name', () => {
    const p = getJobHomePath('daily-standup');
    expect(p).toBe(path.join(routinesDir, 'daily-standup', 'home'));
    expect(p.startsWith(routinesDir + path.sep)).toBe(true);
  });

  it('allows dot-prefixed names', () => {
    expect(() => getJobHomePath('.hidden-job')).not.toThrow();
  });

  // A synced user/system routine YAML controls `name`; without containment,
  // `../../../..` steers cleanJobHome's recursive rmSync at the user's home.
  it('rejects parent-traversal names so rmSync cannot escape the routines dir', () => {
    expect(() => getJobHomePath('../../../../..')).toThrow();
    expect(() => getJobHomePath('..')).toThrow();
  });

  it('rejects names containing path separators', () => {
    expect(() => getJobHomePath('a/b')).toThrow();
    expect(() => getJobHomePath('a\\b')).toThrow();
  });

  it('rejects names with null bytes', () => {
    expect(() => getJobHomePath('evil\x00')).toThrow();
  });
});
