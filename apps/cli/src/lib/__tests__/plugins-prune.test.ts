/**
 * Tests for plugin soft-delete (prune) logic:
 *   - cleanOrphanedPluginSkills: moves orphan plugin skill dirs to trash
 *   - diffVersionPlugins: detects orphan plugin skills by the name--skill pattern
 *   - removePluginSkillFromVersion: soft-deletes a single plugin skill to trash
 *
 * No mocking — all operations use real temp directories on the actual filesystem.
 * Tests that touch real agent version dirs (getVersionsDir) always clean up in finally.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  cleanOrphanedPluginSkills,
  removePluginSkillFromVersion,
} from '../plugins.js';
import { getVersionsDir, getTrashPluginsDir } from '../state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a fresh temp dir and track it for cleanup in afterEach. */
const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Populate a fake version home at `versionHome` with plugin skill dirs and
 * optionally some regular (non-plugin) skill dirs.
 *
 * @param versionHome  e.g. /tmp/fake-home
 * @param agent        'claude' | 'openclaw'
 * @param pluginSkills list of already-namespaced names like 'myplugin--search'
 * @param regularSkills plain skill dirs with no '--' in name
 */
function makeSkillsDir(
  versionHome: string,
  agent: string,
  pluginSkills: string[],
  regularSkills: string[] = [],
): string {
  const skillsDir = path.join(versionHome, `.${agent}`, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const name of [...pluginSkills, ...regularSkills]) {
    fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
    // Put a sentinel file inside so the rename will move something real.
    fs.writeFileSync(path.join(skillsDir, name, 'skill.md'), `# ${name}`);
  }
  return skillsDir;
}

// ── cleanOrphanedPluginSkills ─────────────────────────────────────────────────

describe('cleanOrphanedPluginSkills', () => {
  it('removes a plugin skill dir when the plugin is not in activePluginNames', () => {
    const versionHome = mkTemp('plugins-prune-clean-');
    const agent = 'claude';
    const skillsDir = makeSkillsDir(versionHome, agent, ['myplugin--search']);

    const trashBase = mkTemp('plugins-trash-');
    // We cannot override getTrashPluginsDir(), so run against the real trash dir.
    // Use a unique version label so we can locate our specific trash entry.
    const fakeVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
    const trashVersionDir = path.join(getTrashPluginsDir(), agent, fakeVersion);

    try {
      const removed = cleanOrphanedPluginSkills(
        agent,
        versionHome,
        new Set<string>(), // activePlugins = empty → 'myplugin' is an orphan
        fakeVersion,
      );

      expect(removed).toEqual(['myplugin--search']);

      // Source is gone.
      expect(fs.existsSync(path.join(skillsDir, 'myplugin--search'))).toBe(false);

      // Trash dir for this agent/version/skillName received exactly one entry.
      const trashSkillDir = path.join(trashVersionDir, 'myplugin--search');
      const stamps = fs.readdirSync(trashSkillDir);
      expect(stamps.length).toBe(1);

      // The trashed directory contains the sentinel file.
      expect(
        fs.existsSync(path.join(trashSkillDir, stamps[0], 'skill.md')),
      ).toBe(true);
    } finally {
      if (fs.existsSync(trashVersionDir)) {
        fs.rmSync(trashVersionDir, { recursive: true, force: true });
      }
    }
  });

  it('keeps a plugin skill dir when the plugin is active', () => {
    const versionHome = mkTemp('plugins-prune-keep-');
    const agent = 'claude';
    const skillsDir = makeSkillsDir(versionHome, agent, ['myplugin--search']);

    const fakeVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;

    const removed = cleanOrphanedPluginSkills(
      agent,
      versionHome,
      new Set(['myplugin']), // plugin is active
      fakeVersion,
    );

    expect(removed).toEqual([]);
    // Source is still there.
    expect(fs.existsSync(path.join(skillsDir, 'myplugin--search'))).toBe(true);
  });

  it('ignores regular skill dirs without the -- separator', () => {
    const versionHome = mkTemp('plugins-prune-regular-');
    const agent = 'claude';
    makeSkillsDir(versionHome, agent, [], ['read', 'write', 'my_skill']);

    const fakeVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;

    const removed = cleanOrphanedPluginSkills(
      agent,
      versionHome,
      new Set<string>(), // no active plugins
      fakeVersion,
    );

    // None of the regular skills should be reported as orphans.
    expect(removed).toEqual([]);
  });

  it('handles multiple plugin skills, removing only the orphaned ones', () => {
    const versionHome = mkTemp('plugins-prune-multi-');
    const agent = 'claude';
    const skillsDir = makeSkillsDir(versionHome, agent, [
      'active--search',
      'orphaned--translate',
      'active--summarize',
      'orphaned--embed',
    ]);

    const fakeVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
    const trashVersionDir = path.join(getTrashPluginsDir(), agent, fakeVersion);

    try {
      const removed = cleanOrphanedPluginSkills(
        agent,
        versionHome,
        new Set(['active']),
        fakeVersion,
      );

      expect(removed.sort()).toEqual(['orphaned--embed', 'orphaned--translate']);

      // Active plugin skills untouched.
      expect(fs.existsSync(path.join(skillsDir, 'active--search'))).toBe(true);
      expect(fs.existsSync(path.join(skillsDir, 'active--summarize'))).toBe(true);

      // Orphaned skills moved to trash.
      expect(fs.existsSync(path.join(skillsDir, 'orphaned--translate'))).toBe(false);
      expect(fs.existsSync(path.join(skillsDir, 'orphaned--embed'))).toBe(false);
    } finally {
      if (fs.existsSync(trashVersionDir)) {
        fs.rmSync(trashVersionDir, { recursive: true, force: true });
      }
    }
  });

  it('returns empty array when skills directory does not exist', () => {
    const versionHome = mkTemp('plugins-prune-nodir-');
    // Do NOT create any .claude/skills/ dir.

    const removed = cleanOrphanedPluginSkills(
      'claude',
      versionHome,
      new Set<string>(),
      'nonexistent-version',
    );

    expect(removed).toEqual([]);
  });

  it('handles a plugin skill whose name contains multiple -- occurrences', () => {
    // Plugin named "my--plugin" (hypothetically) should use the FIRST -- as separator.
    // diffVersionPlugins and cleanOrphanedPluginSkills use indexOf('--') which finds the
    // first occurrence, so pluginName = 'my' and skillName = 'plugin'.
    // This test documents that behavior: 'my--plugin--search' → pluginName = 'my'.
    const versionHome = mkTemp('plugins-prune-multi-dash-');
    const agent = 'claude';
    const skillsDir = makeSkillsDir(versionHome, agent, ['my--plugin--search']);

    const fakeVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
    const trashVersionDir = path.join(getTrashPluginsDir(), agent, fakeVersion);

    try {
      // 'my' is not active → treated as orphan.
      const removed = cleanOrphanedPluginSkills(
        agent,
        versionHome,
        new Set<string>(),
        fakeVersion,
      );

      expect(removed).toEqual(['my--plugin--search']);
      expect(fs.existsSync(path.join(skillsDir, 'my--plugin--search'))).toBe(false);
    } finally {
      if (fs.existsSync(trashVersionDir)) {
        fs.rmSync(trashVersionDir, { recursive: true, force: true });
      }
    }
  });
});

// ── removePluginSkillFromVersion ──────────────────────────────────────────────

describe('removePluginSkillFromVersion', () => {
  it('soft-deletes a plugin skill dir to the trash and returns success', () => {
    const agent = 'claude';
    const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
    const versionDir = path.join(getVersionsDir(), agent, testVersion);
    const skillName = 'myplugin--search';
    const skillPath = path.join(versionDir, 'home', `.${agent}`, 'skills', skillName);
    const trashSkillDir = path.join(getTrashPluginsDir(), agent, testVersion, skillName);

    try {
      // Set up a fake installed version with a plugin skill.
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, 'skill.md'), '# search');

      const result = removePluginSkillFromVersion(agent, testVersion, skillName);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Source is gone.
      expect(fs.existsSync(skillPath)).toBe(false);

      // Trash dir received exactly one timestamped entry containing the sentinel.
      const stamps = fs.readdirSync(trashSkillDir);
      expect(stamps.length).toBe(1);
      expect(
        fs.existsSync(path.join(trashSkillDir, stamps[0], 'skill.md')),
      ).toBe(true);
    } finally {
      if (fs.existsSync(versionDir)) {
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      if (fs.existsSync(trashSkillDir)) {
        fs.rmSync(trashSkillDir, { recursive: true, force: true });
      }
    }
  });

  it('returns success immediately when the skill path does not exist', () => {
    const agent = 'claude';
    const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;

    // No filesystem setup — skill does not exist.
    const result = removePluginSkillFromVersion(agent, testVersion, 'ghost--skill');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('trash structure is ~/.agents/.trash/plugins/{agent}/{version}/{skillName}/{stamp}', () => {
    const agent = 'claude';
    const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
    const versionDir = path.join(getVersionsDir(), agent, testVersion);
    const skillName = 'namespaced--skill';
    const skillPath = path.join(versionDir, 'home', `.${agent}`, 'skills', skillName);
    const expectedTrashDir = path.join(getTrashPluginsDir(), agent, testVersion, skillName);

    try {
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, 'skill.md'), '# ns');

      removePluginSkillFromVersion(agent, testVersion, skillName);

      // The trash entry is under getTrashPluginsDir() / agent / version / skillName / <stamp>.
      expect(fs.existsSync(expectedTrashDir)).toBe(true);
      const stamps = fs.readdirSync(expectedTrashDir);
      expect(stamps.length).toBe(1);
      // Stamp should be an ISO timestamp with colons/dots replaced by dashes.
      expect(stamps[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    } finally {
      if (fs.existsSync(versionDir)) {
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      if (fs.existsSync(expectedTrashDir)) {
        fs.rmSync(expectedTrashDir, { recursive: true, force: true });
      }
    }
  });
});
