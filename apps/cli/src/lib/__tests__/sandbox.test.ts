import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { JobConfig } from '../routines.js';
import { generateCodexConfig, generateCursorConfig } from '../sandbox.js';

const tempDirs: string[] = [];

function makeJobConfig(config?: Record<string, unknown>): JobConfig {
  return {
    name: 'sandbox-test',
    schedule: '0 * * * *',
    agent: 'codex',
    mode: 'plan',
    effort: 'auto',
    timeout: '30m',
    enabled: true,
    prompt: 'test prompt',
    config,
  };
}

function createOverlayHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sandbox-test-'));
  tempDirs.push(dir);
  return dir;
}

function readCodexConfig(overlayHome: string): string {
  return fs.readFileSync(path.join(overlayHome, '.codex', 'config.toml'), 'utf-8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('generateCodexConfig', () => {
  it('blocks injected directives in model values', () => {
    const overlayHome = createOverlayHome();

    expect(() => generateCodexConfig(overlayHome, makeJobConfig({
      model: 'foo"\napproval_mode = "full-auto',
    }))).toThrow(/TOML value contains newline/);
  });

  it('escapes backslashes in string values', () => {
    const overlayHome = createOverlayHome();

    generateCodexConfig(overlayHome, makeJobConfig({
      model: 'path\\to\\thing',
    }));

    const output = readCodexConfig(overlayHome);
    expect(output).toContain('model = "path\\\\to\\\\thing"');
  });

  it('preserves normal model values', () => {
    const overlayHome = createOverlayHome();

    generateCodexConfig(overlayHome, makeJobConfig({
      model: 'claude-opus-4-7',
    }));

    const output = readCodexConfig(overlayHome);
    expect(output).toContain('model = "claude-opus-4-7"');
  });

  it('rejects injected directives in other string config keys', () => {
    const overlayHome = createOverlayHome();

    expect(() => generateCodexConfig(overlayHome, makeJobConfig({
      someKey: 'value\ninjected = true',
    }))).toThrow(/TOML value contains newline/);
  });
});

describe('generateCursorConfig', () => {
  it('links the same-host Cursor auth file into the overlay', () => {
    const overlayHome = createOverlayHome();
    const realConfigHome = createOverlayHome();
    const cursorDir = path.join(realConfigHome, 'cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const realAuth = path.join(cursorDir, 'auth.json');
    fs.writeFileSync(realAuth, '{}', { mode: 0o600 });
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = realConfigHome;
    try {
      generateCursorConfig(overlayHome);
      expect(fs.realpathSync(path.join(overlayHome, '.config', 'cursor', 'auth.json'))).toBe(fs.realpathSync(realAuth));
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});
