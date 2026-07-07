/**
 * Tests for layered hook manifest resolution: system + user merged, user wins.
 *
 * The registrar reads ~/.agents-system/hooks.yaml (npm-shipped defaults) and
 * the `hooks:` section of ~/.agents/agents.yaml (user). A user entry with
 * the same name as a system entry overrides it wholesale. A user entry with
 * `enabled: false` disables the system-shipped hook.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let SYSTEM_DIR: string;
let USER_DIR: string;
let ENABLED_EXTRAS: Array<{ alias: string; dir: string; url: string }>;

vi.mock('../state.js', () => ({
  get getAgentsDir() { return () => SYSTEM_DIR; },
  get getSystemAgentsDir() { return () => SYSTEM_DIR; },
  get getUserAgentsDir() { return () => USER_DIR; },
  get getHooksDir() { return () => path.join(SYSTEM_DIR, 'hooks'); },
  get getSystemHooksDir() { return () => path.join(SYSTEM_DIR, 'hooks'); },
  get getUserHooksDir() { return () => path.join(USER_DIR, 'hooks'); },
  get getProjectAgentsDir() { return () => null; },
  get getEnabledExtraRepos() { return () => ENABLED_EXTRAS; },
}));

vi.mock('../agents.js', () => ({
  AGENTS: {},
  ALL_AGENT_IDS: [],
  HOOKS_CAPABLE_AGENTS: [],
}));

vi.mock('../capabilities.js', () => ({
  supports: () => ({ ok: true }),
  explainSkip: () => '',
}));

vi.mock('../versions.js', () => ({
  getEffectiveHome: () => '/tmp/none',
  getVersionHomePath: () => '/tmp/none',
  listInstalledVersions: () => [],
}));

import { parseHookManifest } from '../hooks.js';

describe('parseHookManifest layering', () => {
  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-layer-'));
    SYSTEM_DIR = path.join(TEST_ROOT, '.agents-system');
    USER_DIR = path.join(TEST_ROOT, '.agents');
    fs.mkdirSync(SYSTEM_DIR, { recursive: true });
    fs.mkdirSync(USER_DIR, { recursive: true });
    ENABLED_EXTRAS = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('returns empty when neither manifest exists', () => {
    expect(parseHookManifest()).toEqual({});
  });

  it('returns system manifest when only system file exists', () => {
    fs.writeFileSync(
      path.join(SYSTEM_DIR, 'agents.yaml'),
      'hooks:\n  sys-hook:\n    script: a.sh\n    events: [Stop]\n',
      'utf-8'
    );
    const out = parseHookManifest();
    expect(out['sys-hook'].script).toBe('a.sh');
  });

  it('returns user manifest when only user file exists', () => {
    fs.writeFileSync(
      path.join(USER_DIR, 'agents.yaml'),
      'hooks:\n  user-hook:\n    script: b.sh\n    events: [Stop]\n',
      'utf-8'
    );
    const out = parseHookManifest();
    expect(out['user-hook'].script).toBe('b.sh');
  });

  it('merges both manifests when names do not collide', () => {
    fs.writeFileSync(
      path.join(SYSTEM_DIR, 'agents.yaml'),
      'hooks:\n  sys-hook:\n    script: s.sh\n    events: [Stop]\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(USER_DIR, 'agents.yaml'),
      'hooks:\n  user-hook:\n    script: u.sh\n    events: [Stop]\n',
      'utf-8'
    );
    const out = parseHookManifest();
    expect(Object.keys(out).sort()).toEqual(['sys-hook', 'user-hook']);
    expect(out['sys-hook'].script).toBe('s.sh');
    expect(out['user-hook'].script).toBe('u.sh');
  });

  it('user entry overrides system entry of the same name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(SYSTEM_DIR, 'agents.yaml'),
      'hooks:\n  shared:\n    script: system.sh\n    events: [Stop]\n    timeout: 5\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(USER_DIR, 'agents.yaml'),
      'hooks:\n  shared:\n    script: user.sh\n    events: [UserPromptSubmit]\n    timeout: 10\n',
      'utf-8'
    );
    const out = parseHookManifest();
    expect(out['shared'].script).toBe('user.sh');
    expect(out['shared'].events).toEqual(['UserPromptSubmit']);
    expect(out['shared'].timeout).toBe(10);
    expect(warn).toHaveBeenCalledWith(
      "[agents hooks] User-layer hook 'shared' shadows system-shipped hook. Set 'override: true' to silence this warning.",
    );
  });

  it('enabled: false in user entry disables a system-shipped hook by name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(SYSTEM_DIR, 'agents.yaml'),
      'hooks:\n  enforced:\n    script: enforce.sh\n    events: [Stop]\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(USER_DIR, 'agents.yaml'),
      'hooks:\n  enforced:\n    enabled: false\n    script: enforce.sh\n    events: [Stop]\n',
      'utf-8'
    );
    const out = parseHookManifest();
    expect(out).not.toHaveProperty('enforced');
    expect(warn).toHaveBeenCalledWith(
      "[agents hooks] User-layer hook 'enforced' disables system-shipped hook. Set 'override: true' to silence this warning.",
    );
  });

  it('override: true silences the user-layer shadow warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(SYSTEM_DIR, 'agents.yaml'),
      'hooks:\n  shared:\n    script: system.sh\n    events: [Stop]\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(USER_DIR, 'agents.yaml'),
      'hooks:\n  shared:\n    override: true\n    script: user.sh\n    events: [Stop]\n',
      'utf-8'
    );
    const out = parseHookManifest();
    expect(out['shared'].script).toBe('user.sh');
    expect(warn).not.toHaveBeenCalled();
  });

  // Regression for #602: an enabled extra repo declaring a hook (with its
  // event, e.g. SessionStart) must surface in parseHookManifest so the event
  // actually registers. Before the fix parseHookManifest read only the system
  // and user agents.yaml, so extra-repo hook scripts resolved but their events
  // never wired.
  it('includes hook events declared in an enabled extra repo (#602)', () => {
    const extraDir = path.join(TEST_ROOT, 'extra-work');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(
      path.join(extraDir, 'agents.yaml'),
      'hooks:\n  work-session:\n    script: session-start.sh\n    events: [SessionStart]\n    timeout: 7\n',
      'utf-8'
    );
    ENABLED_EXTRAS = [{ alias: 'work', dir: extraDir, url: 'gh:me/.agents-work' }];

    const out = parseHookManifest();
    expect(out['work-session']).toBeDefined();
    expect(out['work-session'].script).toBe('session-start.sh');
    expect(out['work-session'].events).toEqual(['SessionStart']);
    expect(out['work-session'].timeout).toBe(7);
  });

  it('extra-repo hooks sit above system but below user in precedence (#602)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const extraDir = path.join(TEST_ROOT, 'extra-work');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(
      path.join(SYSTEM_DIR, 'agents.yaml'),
      'hooks:\n  shared:\n    script: system.sh\n    events: [Stop]\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(extraDir, 'agents.yaml'),
      'hooks:\n  shared:\n    script: extra.sh\n    events: [Stop]\n',
      'utf-8'
    );
    ENABLED_EXTRAS = [{ alias: 'work', dir: extraDir, url: 'gh:me/.agents-work' }];

    // Extra beats system.
    expect(parseHookManifest()['shared'].script).toBe('extra.sh');

    // User beats extra.
    fs.writeFileSync(
      path.join(USER_DIR, 'agents.yaml'),
      'hooks:\n  shared:\n    override: true\n    script: user.sh\n    events: [Stop]\n',
      'utf-8'
    );
    expect(parseHookManifest()['shared'].script).toBe('user.sh');
  });

  it('earlier extra repo wins over a later one on name collision (#602)', () => {
    const workDir = path.join(TEST_ROOT, 'extra-work');
    const teamDir = path.join(TEST_ROOT, 'extra-team');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'agents.yaml'),
      'hooks:\n  shared:\n    script: from-work.sh\n    events: [SessionStart]\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(teamDir, 'agents.yaml'),
      'hooks:\n  shared:\n    script: from-team.sh\n    events: [SessionStart]\n',
      'utf-8'
    );
    ENABLED_EXTRAS = [
      { alias: 'work', dir: workDir, url: 'gh:me/.agents-work' },
      { alias: 'team', dir: teamDir, url: 'gh:team/.agents' },
    ];

    expect(parseHookManifest()['shared'].script).toBe('from-work.sh');
  });

  it('enabled: false on an extra-repo hook strips it (#602)', () => {
    const extraDir = path.join(TEST_ROOT, 'extra-work');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(
      path.join(extraDir, 'agents.yaml'),
      'hooks:\n  work-session:\n    enabled: false\n    script: session-start.sh\n    events: [SessionStart]\n',
      'utf-8'
    );
    ENABLED_EXTRAS = [{ alias: 'work', dir: extraDir, url: 'gh:me/.agents-work' }];

    expect(parseHookManifest()).not.toHaveProperty('work-session');
  });
});
