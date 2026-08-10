import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = process.cwd();
const entrypoint = path.join(repoRoot, 'src/index.ts');

function runAgents(home: string, args: string[]): string {
  return execFileSync('bun', [entrypoint, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('config command', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-config-test-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('sets and gets a run model default', () => {
    const setOut = runAgents(home, ['config', 'set', 'run.claude@*.model', 'claude-opus-4-8']);
    expect(setOut).toContain('run.claude@*.model');
    expect(setOut).toContain('claude-opus-4-8');

    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('run:');
    expect(yaml).toContain('claude:*');
    expect(yaml).toContain('model: claude-opus-4-8');

    const getOut = runAgents(home, ['config', 'get', 'run.claude@*.model']);
    expect(getOut).toContain('claude-opus-4-8');
  });

  it('sets and gets a tier override', () => {
    const setOut = runAgents(home, [
      'config',
      'set',
      'run.claude@*.tier.best',
      'claude-opus-4-8',
    ]);
    expect(setOut).toContain('run.claude@*.tier.best');

    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('model:');
    expect(yaml).toContain('tiers:');
    expect(yaml).toContain('claude:*');
    expect(yaml).toContain('best: claude-opus-4-8');

    const getOut = runAgents(home, ['config', 'get', 'run.claude@*.tier.best']);
    expect(getOut).toContain('claude-opus-4-8');
  });

  it('sets and gets the interactive host', () => {
    runAgents(home, ['config', 'set', 'interactive.host', 'zion']);
    const getOut = runAgents(home, ['config', 'get', 'interactive.host']);
    expect(getOut).toContain('zion');
  });

  it('sets and unsets the browser profile', () => {
    runAgents(home, ['config', 'set', 'browser.profile', 'work']);
    let getOut = runAgents(home, ['config', 'get', 'browser.profile']);
    expect(getOut).toContain('work');

    runAgents(home, ['config', 'unset', 'browser.profile']);
    getOut = runAgents(home, ['config', 'get', 'browser.profile']);
    expect(getOut).toContain('(unset)');
  });

  it('lists configured values', () => {
    runAgents(home, ['config', 'set', 'run.claude@*.model', 'best']);
    runAgents(home, ['config', 'set', 'run.claude@*.tier.best', 'claude-opus-4-8']);
    runAgents(home, ['config', 'set', 'interactive.host', 'zion']);

    const listOut = runAgents(home, ['config', 'list']);
    expect(listOut).toContain('run.claude@*.model');
    expect(listOut).toContain('best');
    expect(listOut).toContain('run.claude@*.tier.best');
    expect(listOut).toContain('claude-opus-4-8');
    expect(listOut).toContain('interactive.host');
    expect(listOut).toContain('zion');
  });

  it('unsets a run default', () => {
    runAgents(home, ['config', 'set', 'run.claude@*.model', 'best']);
    const unsetOut = runAgents(home, ['config', 'unset', 'run.claude@*.model']);
    expect(unsetOut).toContain('Unset');

    const getOut = runAgents(home, ['config', 'get', 'run.claude@*.model']);
    expect(getOut).toContain('(unset)');
  });

  it('lists browser.profile once for this machine', () => {
    runAgents(home, ['config', 'set', 'browser.profile', 'work']);
    const listOut = runAgents(home, ['config', 'list']);
    // Count how many times the top-level key appears; the self device must not
    // duplicate it as devices.<self>.browser.profile.
    const matches = listOut.match(/browser\.profile/g) ?? [];
    expect(matches.length).toBe(1);
    expect(listOut).not.toMatch(/devices\.[\w-]+\.browser\.profile/);
  });

  it('rejects unknown keys', () => {
    expect(() => runAgents(home, ['config', 'get', 'foo.bar'])).toThrow(/Unknown config scope/);
  });

  it('rejects invalid run property', () => {
    expect(() => runAgents(home, ['config', 'set', 'run.claude@*.foo', 'x'])).toThrow(
      /Invalid run config key/,
    );
  });
});
