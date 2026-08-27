/**
 * RUSH-2989 — leftover top-level aliases nested under their owning groups.
 * Pins that `unshare` / `audit` / `trends` are unregistered at the root and
 * cannot auto-correct, while the nested homes still exist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildFullCommandTree } from '../cli/command-registry.js';
import {
  isKnownTopLevelCommand,
  RETIRED_TOP_LEVEL_COMMANDS,
} from '../lib/startup/command-registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string | undefined;

afterEach(() => {
  if (testHome) {
    fs.rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  }
});

function guardedHome(): string {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-nest-retired-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return testHome;
}

function run(home: string, ...args: string[]) {
  return spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_SECRETS_PASSPHRASE: '',
    },
  });
}

describe('RUSH-2989 nested leftover aliases', () => {
  it('unshare/audit/trends are gone from the root tree and marked retired', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('unshare');
    expect(names).not.toContain('audit');
    expect(names).not.toContain('trends');
    expect(names).toContain('artifacts');
    expect(names).toContain('events');
    expect(names).toContain('insights');
    // 'org' stayed retired with the Prix-coupled account layer; 'auth' returned
    // against Phoenix ID, with the team surface nested as `auth space` (RUSH-2581).
    expect(names).not.toContain('org');
    expect(names).toContain('auth');

    const artifacts = program.commands.find((c) => c.name() === 'artifacts');
    expect(artifacts?.commands.map((c) => c.name())).toContain('unshare');
    const events = program.commands.find((c) => c.name() === 'events');
    expect(events?.commands.map((c) => c.name())).toContain('audit');
    const insights = program.commands.find((c) => c.name() === 'insights');
    expect(insights?.commands.map((c) => c.name())).toContain('trends');

    for (const name of ['unshare', 'audit', 'trends'] as const) {
      expect(isKnownTopLevelCommand(name)).toBe(false);
      expect(RETIRED_TOP_LEVEL_COMMANDS.has(name)).toBe(true);
    }
    expect(isKnownTopLevelCommand('org')).toBe(false);
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('org')).toBe(true);
    expect(isKnownTopLevelCommand('auth')).toBe(true);
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('auth')).toBe(false);

    const authCmd = program.commands.find((c) => c.name() === 'auth');
    expect(authCmd?.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['login', 'whoami', 'logout', 'space', 'mint']),
    );
  });

  it('`agents org list` is an unknown command after the Prix-layer removal (RUSH-2581)', () => {
    const home = guardedHome();
    const r = run(home, 'org', 'list');
    expect(r.stderr ?? '').toMatch(/unknown command 'org'/);
    expect(r.status).not.toBe(0);
  });

  it.each(['unshare', 'audit', 'trends'] as const)(
    'a bare `agents %s` is an unknown command, not an auto-correct',
    (name) => {
      const home = guardedHome();
      const r = run(home, name);
      expect(r.status).not.toBe(0);
      expect(r.stderr ?? '').toMatch(/unknown command/i);
    },
  );
});

describe('RUSH-3079 removed `usage` command (duplicate of `agents view`)', () => {
  it('usage is gone from the root tree and marked retired', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('usage');
    expect(names).toContain('view');
    expect(isKnownTopLevelCommand('usage')).toBe(false);
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('usage')).toBe(true);
  });

  it('a bare `agents usage` is an unknown command, not an auto-correct', () => {
    const home = guardedHome();
    const r = run(home, 'usage');
    expect(r.status).not.toBe(0);
    expect(r.stderr ?? '').toMatch(/unknown command/i);
  });
});
