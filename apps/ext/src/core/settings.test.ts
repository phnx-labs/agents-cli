import { describe, test, expect } from 'bun:test';
import {
  getDefaultSettings,
  hasLoginEnabled,
  migrateStaleClaudeQuickLaunch,
  AgentSettings,
  QuickLaunchConfig,
} from './settings';

describe('getDefaultSettings', () => {
  test('returns valid settings structure', () => {
    const settings = getDefaultSettings();

    expect(settings.builtIn).toBeDefined();
    expect(settings.builtIn.claude).toBeDefined();
    expect(settings.builtIn.codex).toBeDefined();
    expect(settings.builtIn.gemini).toBeDefined();
    expect(settings.builtIn.opencode).toBeDefined();
    expect(settings.builtIn.cursor).toBeDefined();
    expect(settings.custom).toEqual([]);
    expect(settings.editor).toBeDefined();
    expect(settings.display).toBeDefined();
  });

  test('all built-in agents have login disabled by default', () => {
    const settings = getDefaultSettings();

    expect(settings.builtIn.claude.login).toBe(false);
    expect(settings.builtIn.codex.login).toBe(false);
    expect(settings.builtIn.gemini.login).toBe(false);
    expect(settings.builtIn.opencode.login).toBe(false);
    expect(settings.builtIn.cursor.login).toBe(false);
  });

  test('display preferences defaults', () => {
    const settings = getDefaultSettings();
    expect(settings.display.showFullAgentNames).toBe(true);
    expect(settings.display.showLabelsInTitles).toBe(true);
    expect(settings.display.autoLabelInTabTitles).toBe(true);
    expect(settings.display.showSessionIdInTitles).toBe(true);
  });

  test('all built-in agents have 2 instances by default', () => {
    const settings = getDefaultSettings();

    expect(settings.builtIn.claude.instances).toBe(2);
    expect(settings.builtIn.codex.instances).toBe(2);
    expect(settings.builtIn.gemini.instances).toBe(2);
    expect(settings.builtIn.opencode.instances).toBe(2);
    expect(settings.builtIn.cursor.instances).toBe(2);
  });

  test('editor preferences defaults', () => {
    const settings = getDefaultSettings();
    expect(settings.editor.markdownViewerEnabled).toBe(true);
  });
});

describe('hasLoginEnabled', () => {
  test('returns false for default settings', () => {
    const settings = getDefaultSettings();
    expect(hasLoginEnabled(settings)).toBe(false);
  });

  test('returns true when claude login is enabled', () => {
    const settings = getDefaultSettings();
    settings.builtIn.claude.login = true;
    expect(hasLoginEnabled(settings)).toBe(true);
  });

  test('returns true when codex login is enabled', () => {
    const settings = getDefaultSettings();
    settings.builtIn.codex.login = true;
    expect(hasLoginEnabled(settings)).toBe(true);
  });

  test('returns true when custom agent login is enabled', () => {
    const settings = getDefaultSettings();
    settings.custom.push({
      name: 'Custom',
      command: 'custom-cli',
      login: true,
      instances: 1
    });
    expect(hasLoginEnabled(settings)).toBe(true);
  });

  test('returns false when custom agent exists but login is disabled', () => {
    const settings = getDefaultSettings();
    settings.custom.push({
      name: 'Custom',
      command: 'custom-cli',
      login: false,
      instances: 1
    });
    expect(hasLoginEnabled(settings)).toBe(false);
  });
});

describe('migrateStaleClaudeQuickLaunch', () => {
  test('rewrites stale Claude model ids to aliases', () => {
    const cfg: QuickLaunchConfig = {
      slot1: { agent: 'claude', model: 'claude-opus-4-5', label: 'Claude Opus' },
      slot2: { agent: 'claude', model: 'claude-haiku-4-5', label: 'Claude Haiku' },
      slot3: { agent: 'claude', model: 'claude-sonnet-4-5', label: 'Claude Sonnet' },
    };
    expect(migrateStaleClaudeQuickLaunch(cfg)).toBe(true);
    expect(cfg.slot1).toEqual({ agent: 'claude', model: undefined, modelAlias: 'opus', label: 'Claude Opus' });
    expect(cfg.slot2).toEqual({ agent: 'claude', model: undefined, modelAlias: 'haiku', label: 'Claude Haiku' });
    expect(cfg.slot3).toEqual({ agent: 'claude', model: undefined, modelAlias: 'sonnet', label: 'Claude Sonnet' });
  });

  test('leaves non-stale ids alone', () => {
    const cfg: QuickLaunchConfig = {
      slot1: { agent: 'claude', model: 'claude-opus-4-7', label: 'Custom' },
    };
    expect(migrateStaleClaudeQuickLaunch(cfg)).toBe(false);
    expect(cfg.slot1?.model).toBe('claude-opus-4-7');
    expect(cfg.slot1?.modelAlias).toBeUndefined();
  });

  test('does not touch non-Claude slots', () => {
    const cfg: QuickLaunchConfig = {
      slot1: { agent: 'codex', model: 'claude-opus-4-5', label: 'Weird' },
    };
    expect(migrateStaleClaudeQuickLaunch(cfg)).toBe(false);
    expect(cfg.slot1?.model).toBe('claude-opus-4-5');
  });

  test('handles missing slots', () => {
    const cfg: QuickLaunchConfig = {};
    expect(migrateStaleClaudeQuickLaunch(cfg)).toBe(false);
  });
});
