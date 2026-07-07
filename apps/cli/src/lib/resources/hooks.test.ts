/**
 * Tests for HooksHandler - layered hook resolution.
 *
 * Resolution order: project > user > system
 * - Union: All hooks from all layers are combined
 * - Override on name conflict: Higher layer wins (project > user > system)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let SYSTEM_DIR: string;
let USER_DIR: string;
let PROJECT_DIR: string;

// Mock state functions to use test directories
vi.mock('../state.js', () => ({
  get getSystemAgentsDir() { return () => SYSTEM_DIR; },
  get getUserAgentsDir() { return () => USER_DIR; },
  get getProjectAgentsDir() { return () => PROJECT_DIR; },
}));

import { HooksHandler } from './hooks.js';

describe('HooksHandler', () => {
  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-handler-'));
    USER_DIR = path.join(TEST_ROOT, '.agents');
    SYSTEM_DIR = path.join(USER_DIR, '.system');
    PROJECT_DIR = path.join(TEST_ROOT, 'project', '.agents');
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.mkdirSync(SYSTEM_DIR, { recursive: true });
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe('listAll', () => {
    it('returns empty array when no hooks.yaml files exist', () => {
      const result = HooksHandler.listAll('claude');
      expect(result).toEqual([]);
    });

    it('unions non-conflicting hooks from all layers', () => {
      // System hook
      fs.writeFileSync(
        path.join(SYSTEM_DIR, 'hooks.yaml'),
        `system-hook:
  script: system.sh
  events: [Stop]
`,
        'utf-8'
      );

      // User hook
      fs.writeFileSync(
        path.join(USER_DIR, 'agents.yaml'),
        `hooks:
  user-hook:
    script: user.sh
    events: [SessionStart]
`,
        'utf-8'
      );

      // Project hook
      fs.writeFileSync(
        path.join(PROJECT_DIR, 'hooks.yaml'),
        `project-hook:
  script: project.sh
  events: [UserPromptSubmit]
`,
        'utf-8'
      );

      const result = HooksHandler.listAll('claude', PROJECT_DIR);
      const names = result.map(r => r.name);

      expect(names).toContain('system-hook');
      expect(names).toContain('user-hook');
      expect(names).toContain('project-hook');
      expect(result).toHaveLength(3);

      // Verify layers
      const systemHook = result.find(r => r.name === 'system-hook');
      const userHook = result.find(r => r.name === 'user-hook');
      const projectHook = result.find(r => r.name === 'project-hook');

      expect(systemHook?.layer).toBe('system');
      expect(userHook?.layer).toBe('user');
      expect(projectHook?.layer).toBe('project');
    });

    it('project beats user on name conflict', () => {
      // User defines hook "shared"
      fs.writeFileSync(
        path.join(USER_DIR, 'agents.yaml'),
        `hooks:
  shared:
    script: user-version.sh
    events: [Stop]
    timeout: 10
`,
        'utf-8'
      );

      // Project also defines hook "shared" - should win
      fs.writeFileSync(
        path.join(PROJECT_DIR, 'hooks.yaml'),
        `shared:
  script: project-version.sh
  events: [SessionStart]
  timeout: 20
`,
        'utf-8'
      );

      const result = HooksHandler.listAll('claude', PROJECT_DIR);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared');
      expect(result[0].layer).toBe('project');
      expect(result[0].item.script).toBe('project-version.sh');
      expect(result[0].item.events).toEqual(['SessionStart']);
      expect(result[0].item.timeout).toBe(20);
    });

    it('user beats system on name conflict', () => {
      // System defines hook "shared"
      fs.writeFileSync(
        path.join(SYSTEM_DIR, 'hooks.yaml'),
        `shared:
  script: system-version.sh
  events: [Stop]
  timeout: 5
`,
        'utf-8'
      );

      // User also defines hook "shared" - should win
      fs.writeFileSync(
        path.join(USER_DIR, 'agents.yaml'),
        `hooks:
  shared:
    script: user-version.sh
    events: [UserPromptSubmit]
    timeout: 15
`,
        'utf-8'
      );

      const result = HooksHandler.listAll('claude');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared');
      expect(result[0].layer).toBe('user');
      expect(result[0].item.script).toBe('user-version.sh');
      expect(result[0].item.events).toEqual(['UserPromptSubmit']);
      expect(result[0].item.timeout).toBe(15);
    });

    it('enabled: false in higher layer disables hook from lower layers', () => {
      // System defines a hook
      fs.writeFileSync(
        path.join(SYSTEM_DIR, 'hooks.yaml'),
        `enforced:
  script: enforce.sh
  events: [Stop]
`,
        'utf-8'
      );

      // User disables it
      fs.writeFileSync(
        path.join(USER_DIR, 'agents.yaml'),
        `hooks:
  enforced:
    enabled: false
    script: enforce.sh
    events: [Stop]
`,
        'utf-8'
      );

      const result = HooksHandler.listAll('claude');

      expect(result).toHaveLength(0);
    });
  });

  describe('resolve', () => {
    it('returns null when hook not found', () => {
      const result = HooksHandler.resolve('claude', 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns hook from system when only system has it', () => {
      fs.writeFileSync(
        path.join(SYSTEM_DIR, 'hooks.yaml'),
        `system-only:
  script: system.sh
  events: [Stop]
`,
        'utf-8'
      );

      const result = HooksHandler.resolve('claude', 'system-only');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('system-only');
      expect(result?.layer).toBe('system');
      expect(result?.item.script).toBe('system.sh');
    });

    it('returns user version when both user and system have hook', () => {
      fs.writeFileSync(
        path.join(SYSTEM_DIR, 'hooks.yaml'),
        `shared:
  script: system.sh
  events: [Stop]
`,
        'utf-8'
      );

      fs.writeFileSync(
        path.join(USER_DIR, 'agents.yaml'),
        `hooks:
  shared:
    script: user.sh
    events: [SessionStart]
`,
        'utf-8'
      );

      const result = HooksHandler.resolve('claude', 'shared');

      expect(result).not.toBeNull();
      expect(result?.layer).toBe('user');
      expect(result?.item.script).toBe('user.sh');
    });

    it('returns project version when all layers have hook', () => {
      fs.writeFileSync(
        path.join(SYSTEM_DIR, 'hooks.yaml'),
        `shared:
  script: system.sh
  events: [Stop]
`,
        'utf-8'
      );

      fs.writeFileSync(
        path.join(USER_DIR, 'agents.yaml'),
        `hooks:
  shared:
    script: user.sh
    events: [SessionStart]
`,
        'utf-8'
      );

      fs.writeFileSync(
        path.join(PROJECT_DIR, 'hooks.yaml'),
        `shared:
  script: project.sh
  events: [UserPromptSubmit]
`,
        'utf-8'
      );

      const result = HooksHandler.resolve('claude', 'shared', PROJECT_DIR);

      expect(result).not.toBeNull();
      expect(result?.layer).toBe('project');
      expect(result?.item.script).toBe('project.sh');
    });

    it('returns null when hook is disabled in higher layer', () => {
      fs.writeFileSync(
        path.join(SYSTEM_DIR, 'hooks.yaml'),
        `disabled-hook:
  script: system.sh
  events: [Stop]
`,
        'utf-8'
      );

      fs.writeFileSync(
        path.join(USER_DIR, 'agents.yaml'),
        `hooks:
  disabled-hook:
    enabled: false
    script: system.sh
    events: [Stop]
`,
        'utf-8'
      );

      const result = HooksHandler.resolve('claude', 'disabled-hook');

      expect(result).toBeNull();
    });
  });

  describe('format', () => {
    it('returns yaml for all agents', () => {
      expect(HooksHandler.format('claude')).toBe('yaml');
      expect(HooksHandler.format('codex')).toBe('yaml');
      expect(HooksHandler.format('gemini')).toBe('yaml');
    });
  });

  describe('targetDir', () => {
    it('returns hooks for all agents', () => {
      expect(HooksHandler.targetDir('claude')).toBe('hooks');
      expect(HooksHandler.targetDir('codex')).toBe('hooks');
      expect(HooksHandler.targetDir('gemini')).toBe('hooks');
    });
  });
});
