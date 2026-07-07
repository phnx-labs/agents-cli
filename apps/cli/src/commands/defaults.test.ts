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

describe('defaults command', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-defaults-test-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('sets, lists, and unsets run defaults', () => {
    const setOut = runAgents(home, ['defaults', 'run', 'set', 'claude@2.1.45', '--mode', 'full', '--model', 'opus']);
    expect(setOut).toContain('claude:2.1.45');
    expect(setOut).toContain('mode skip');
    expect(setOut).toContain('model opus');

    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('claude:2.1.45');
    expect(yaml).toContain('mode: skip');
    expect(yaml).toContain('model: opus');

    const listOut = runAgents(home, ['defaults', 'run', 'list']);
    expect(listOut).toContain('claude:2.1.45');
    expect(listOut).toContain('mode skip');
    expect(listOut).toContain('model opus');

    const unsetOut = runAgents(home, ['defaults', 'run', 'unset', 'claude:2.1.45']);
    expect(unsetOut).toContain('Removed run default claude:2.1.45');

    const emptyListOut = runAgents(home, ['defaults', 'run', 'list']);
    expect(emptyListOut).toContain('No run defaults configured');
  });
});
