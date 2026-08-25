import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openCodeConfigPath } from './permissions.js';

describe('openCodeConfigPath (RUSH-1623)', () => {
  it('resolves user config under ~/.config/opencode/', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-'));
    const p = openCodeConfigPath('user', undefined, home);
    expect(p).toBe(path.join(home, '.config', 'opencode', 'opencode.jsonc'));
  });

  it('prefers existing opencode.json when present', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-'));
    const dir = path.join(home, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const json = path.join(dir, 'opencode.json');
    fs.writeFileSync(json, '{}');
    expect(openCodeConfigPath('user', undefined, home)).toBe(json);
  });

  it('resolves project config at project root', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-proj-'));
    expect(openCodeConfigPath('project', cwd)).toBe(path.join(cwd, 'opencode.jsonc'));
  });
});
