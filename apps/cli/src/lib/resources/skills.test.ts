/**
 * Tests for SkillsHandler.
 *
 * Uses real filesystem with temp directories, no mocking.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSkillsHandler, type SkillItem, type LayerDirProvider } from './skills.js';
import type { ResourceHandler } from './types.js';

// Test state
let testRoot: string;
let systemDir: string;
let userDir: string;
let projectDir: string;
let projectCwd: string;
let handler: ResourceHandler<SkillItem>;

function createSkill(baseDir: string, name: string, metadata: Record<string, string>): string {
  const skillDir = path.join(baseDir, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });

  const frontmatter = Object.entries(metadata)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n\n# ${metadata.name || name}\n\nSkill content here.`
  );

  return skillDir;
}

function createSkillWithRules(
  baseDir: string,
  name: string,
  metadata: Record<string, string>,
  rules: string[]
): string {
  const skillDir = createSkill(baseDir, name, metadata);
  const rulesDir = path.join(skillDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  for (const rule of rules) {
    fs.writeFileSync(path.join(rulesDir, `${rule}.md`), `# ${rule}\n\nRule content.`);
  }

  return skillDir;
}

beforeEach(() => {
  // Create temp directory structure
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  systemDir = path.join(testRoot, 'system');
  userDir = path.join(testRoot, 'user');
  projectDir = path.join(testRoot, 'project', '.agents');
  projectCwd = path.join(testRoot, 'project');

  fs.mkdirSync(path.join(systemDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'skills'), { recursive: true });
  // Create .git to mark project boundary
  fs.mkdirSync(path.join(projectCwd, '.git'), { recursive: true });

  // Create handler with test-specific provider
  const provider: LayerDirProvider = {
    getSystemSkillsDir: () => path.join(systemDir, 'skills'),
    getUserSkillsDir: () => path.join(userDir, 'skills'),
    getProjectAgentsDir: (cwd?: string) => {
      if (cwd && cwd.startsWith(projectCwd)) return projectDir;
      return null;
    },
    getEnabledExtraRepos: () => [],
  };

  handler = createSkillsHandler(provider);
});

afterEach(() => {
  // Clean up temp directory
  if (testRoot && fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

describe('SkillsHandler', () => {
  describe('listAll', () => {
    test('returns empty array when no skills exist', () => {
      const result = handler.listAll('claude');
      expect(result).toEqual([]);
    });

    test('lists skills from system layer', () => {
      createSkill(systemDir, 'system-skill', {
        name: 'system-skill',
        description: 'A system skill',
      });

      const result = handler.listAll('claude');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('system-skill');
      expect(result[0].layer).toBe('system');
      expect(result[0].item.metadata.name).toBe('system-skill');
      expect(result[0].item.metadata.description).toBe('A system skill');
    });

    test('lists skills from user layer', () => {
      createSkill(userDir, 'user-skill', {
        name: 'user-skill',
        description: 'A user skill',
      });

      const result = handler.listAll('claude');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('user-skill');
      expect(result[0].layer).toBe('user');
    });

    test('lists skills from project layer with cwd', () => {
      createSkill(projectDir, 'project-skill', {
        name: 'project-skill',
        description: 'A project skill',
      });

      const result = handler.listAll('claude', projectCwd);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('project-skill');
      expect(result[0].layer).toBe('project');
    });

    test('unions skills from all layers', () => {
      createSkill(systemDir, 'system-only', {
        name: 'system-only',
        description: 'System only',
      });
      createSkill(userDir, 'user-only', {
        name: 'user-only',
        description: 'User only',
      });
      createSkill(projectDir, 'project-only', {
        name: 'project-only',
        description: 'Project only',
      });

      const result = handler.listAll('claude', projectCwd);

      expect(result).toHaveLength(3);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['project-only', 'system-only', 'user-only']);
    });

    test('counts rules correctly', () => {
      createSkillWithRules(
        userDir,
        'skill-with-rules',
        { name: 'skill-with-rules', description: 'Has rules' },
        ['rule1', 'rule2', 'rule3']
      );

      const result = handler.listAll('claude');

      expect(result).toHaveLength(1);
      expect(result[0].item.ruleCount).toBe(3);
    });
  });

  describe('override behavior', () => {
    test('user layer overrides system layer on name conflict', () => {
      createSkill(systemDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'System version',
      });
      createSkill(userDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'User version',
      });

      const result = handler.listAll('claude');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared-skill');
      expect(result[0].layer).toBe('user');
      expect(result[0].item.metadata.description).toBe('User version');
    });

    test('project layer overrides user layer on name conflict', () => {
      createSkill(userDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'User version',
      });
      createSkill(projectDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'Project version',
      });

      const result = handler.listAll('claude', projectCwd);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared-skill');
      expect(result[0].layer).toBe('project');
      expect(result[0].item.metadata.description).toBe('Project version');
    });

    test('project layer overrides all layers on name conflict', () => {
      createSkill(systemDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'System version',
      });
      createSkill(userDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'User version',
      });
      createSkill(projectDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'Project version',
      });

      const result = handler.listAll('claude', projectCwd);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared-skill');
      expect(result[0].layer).toBe('project');
      expect(result[0].item.metadata.description).toBe('Project version');
    });
  });

  describe('resolve', () => {
    test('returns null for non-existent skill', () => {
      const result = handler.resolve('claude', 'nonexistent');
      expect(result).toBeNull();
    });

    test('resolves skill from system layer', () => {
      createSkill(systemDir, 'test-skill', {
        name: 'test-skill',
        description: 'Test skill',
      });

      const result = handler.resolve('claude', 'test-skill');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('test-skill');
      expect(result!.layer).toBe('system');
    });

    test('resolves skill from higher layer when same name exists', () => {
      createSkill(systemDir, 'test-skill', {
        name: 'test-skill',
        description: 'System version',
      });
      createSkill(userDir, 'test-skill', {
        name: 'test-skill',
        description: 'User version',
      });

      const result = handler.resolve('claude', 'test-skill');

      expect(result).not.toBeNull();
      expect(result!.layer).toBe('user');
      expect(result!.item.metadata.description).toBe('User version');
    });

    test('resolves project skill with cwd', () => {
      createSkill(projectDir, 'project-skill', {
        name: 'project-skill',
        description: 'Project skill',
      });

      const result = handler.resolve('claude', 'project-skill', projectCwd);

      expect(result).not.toBeNull();
      expect(result!.layer).toBe('project');
    });
  });

  describe('sync', () => {
    test('syncs skills to version home', () => {
      const versionHome = path.join(testRoot, 'version-home');
      fs.mkdirSync(versionHome, { recursive: true });

      createSkill(userDir, 'sync-skill', {
        name: 'sync-skill',
        description: 'Skill to sync',
      });

      handler.sync('claude', versionHome);

      const syncedPath = path.join(versionHome, '.claude', 'skills', 'sync-skill', 'SKILL.md');
      expect(fs.existsSync(syncedPath)).toBe(true);
    });

    test('syncs from highest layer when overridden', () => {
      const versionHome = path.join(testRoot, 'version-home');
      fs.mkdirSync(versionHome, { recursive: true });

      createSkill(systemDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'System version',
      });
      createSkill(userDir, 'shared-skill', {
        name: 'shared-skill',
        description: 'User version',
      });

      handler.sync('claude', versionHome);

      const syncedPath = path.join(versionHome, '.claude', 'skills', 'shared-skill', 'SKILL.md');
      const content = fs.readFileSync(syncedPath, 'utf-8');
      expect(content).toContain('User version');
    });
  });

  describe('format and targetDir', () => {
    test('format returns md for all agents', () => {
      expect(handler.format('claude')).toBe('md');
      expect(handler.format('codex')).toBe('md');
      expect(handler.format('gemini')).toBe('md');
    });

    test('targetDir returns agent-specific path', () => {
      expect(handler.targetDir('claude')).toBe('.claude/skills');
      expect(handler.targetDir('codex')).toBe('.codex/skills');
    });
  });

  describe('edge cases', () => {
    test('ignores directories without SKILL.md', () => {
      const emptyDir = path.join(userDir, 'skills', 'empty-dir');
      fs.mkdirSync(emptyDir, { recursive: true });
      fs.writeFileSync(path.join(emptyDir, 'README.md'), '# Not a skill');

      const result = handler.listAll('claude');
      expect(result).toHaveLength(0);
    });

    test('ignores hidden directories', () => {
      const hiddenDir = path.join(userDir, 'skills', '.hidden-skill');
      fs.mkdirSync(hiddenDir, { recursive: true });
      fs.writeFileSync(
        path.join(hiddenDir, 'SKILL.md'),
        '---\nname: hidden\ndescription: Hidden\n---\n'
      );

      const result = handler.listAll('claude');
      expect(result).toHaveLength(0);
    });

    test('skips skills with invalid frontmatter', () => {
      const skillDir = path.join(userDir, 'skills', 'invalid-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# No frontmatter\n\nJust content.');

      const result = handler.listAll('claude');
      expect(result).toHaveLength(0);
    });

    test('handles malformed YAML gracefully', () => {
      const skillDir = path.join(userDir, 'skills', 'bad-yaml');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: [invalid yaml\n---\n');

      const result = handler.listAll('claude');
      expect(result).toHaveLength(0);
    });
  });
});
