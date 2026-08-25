import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readGeminiSettings,
  updateGeminiSettings,
} from '../gemini-settings.js';

describe('gemini-settings', () => {
  it('creates a settings file and persists a mutation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-settings-'));
    const settingsPath = path.join(tempDir, '.gemini', 'antigravity-cli', 'settings.json');

    updateGeminiSettings(settingsPath, (settings) => {
      settings.permissions = { allow: ['Bash(git:*)'] };
    });

    expect(readGeminiSettings(settingsPath)).toEqual({
      permissions: { allow: ['Bash(git:*)'] },
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves existing keys when mutating one field', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-settings-'));
    const settingsPath = path.join(tempDir, '.gemini', 'antigravity-cli', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      permissions: { allow: ['Bash(git:*)'] },
    }, null, 2));

    updateGeminiSettings(settingsPath, (settings) => {
      const perms = settings.permissions as Record<string, unknown>;
      perms.deny = ['Bash(rm:*)'];
    });

    expect(readGeminiSettings(settingsPath)).toEqual({
      theme: 'dark',
      permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] },
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws on invalid JSON instead of silently overwriting the file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-settings-'));
    const settingsPath = path.join(tempDir, '.gemini', 'antigravity-cli', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{not json', 'utf-8');

    expect(() => updateGeminiSettings(settingsPath, (settings) => {
      settings.theme = 'dark';
    })).toThrow();
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{not json');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
