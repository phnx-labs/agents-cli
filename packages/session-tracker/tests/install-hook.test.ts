import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as TOML from 'smol-toml';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('session tracker hook installation', () => {
  it('registers Droid and Kimi SessionStart hooks in their native config formats', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-install-'));
    roots.push(root);
    const result = spawnSync('bunx', ['tsx', 'src/install-hook.ts', 'droid', 'kimi'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: root },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);

    const droid = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'settings.json'), 'utf8'));
    expect(droid.hooks.SessionStart[0].hooks[0].command).toContain('hook.sh droid');

    const kimi = TOML.parse(fs.readFileSync(path.join(root, '.kimi-code', 'config.toml'), 'utf8')) as any;
    expect(kimi.hooks).toContainEqual(expect.objectContaining({ event: 'SessionStart' }));
    expect(kimi.hooks[0].command).toContain('hook.sh kimi');
  });
});
