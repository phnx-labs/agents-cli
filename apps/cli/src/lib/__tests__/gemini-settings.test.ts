import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readGeminiSettings,
  setGeminiAutoUpdateDisabled,
  updateGeminiSettings,
} from '../gemini-settings.js';

describe('gemini-settings', () => {
  it('creates a settings file and disables auto update', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-settings-'));
    const settingsPath = path.join(tempDir, '.gemini', 'settings.json');

    updateGeminiSettings(settingsPath, (settings) => {
      setGeminiAutoUpdateDisabled(settings);
    });

    expect(readGeminiSettings(settingsPath)).toEqual({
      general: { enableAutoUpdate: false },
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves existing general keys when disabling auto update', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-settings-'));
    const settingsPath = path.join(tempDir, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      general: {
        preferredEditor: 'vim',
        enableAutoUpdate: true,
      },
    }, null, 2));

    updateGeminiSettings(settingsPath, (settings) => {
      setGeminiAutoUpdateDisabled(settings);
    });

    expect(readGeminiSettings(settingsPath)).toEqual({
      theme: 'dark',
      general: {
        preferredEditor: 'vim',
        enableAutoUpdate: false,
      },
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws on invalid JSON instead of silently overwriting the file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-settings-'));
    const settingsPath = path.join(tempDir, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{not json', 'utf-8');

    expect(() => updateGeminiSettings(settingsPath, (settings) => {
      setGeminiAutoUpdateDisabled(settings);
    })).toThrow();
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{not json');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
