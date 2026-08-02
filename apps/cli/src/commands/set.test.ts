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

describe('set command', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-set-test-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes the same run.defaults store as `defaults run set`', () => {
    const setOut = runAgents(home, ['set', 'claude@2.1.220', '--model', 'opus-5']);
    expect(setOut).toContain('claude:2.1.220');
    expect(setOut).toContain('model opus-5');

    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('claude:2.1.220');
    expect(yaml).toContain('model: opus-5');

    // `defaults run list` sees exactly what `set` wrote — one source of truth.
    const listOut = runAgents(home, ['defaults', 'run', 'list']);
    expect(listOut).toContain('claude:2.1.220');
    expect(listOut).toContain('model opus-5');
  });

  it('accepts the @ and : selector forms and both flags', () => {
    runAgents(home, ['set', 'claude:*', '--mode', 'full', '--model', 'opus']);
    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('claude:*');
    expect(yaml).toContain('mode: skip'); // 'full' normalizes to 'skip'
    expect(yaml).toContain('model: opus');
  });

  it('shows the current default for a selector when no flags are given', () => {
    runAgents(home, ['set', 'claude@2.1.220', '--model', 'opus-5']);
    const showOut = runAgents(home, ['set', 'claude@2.1.220']);
    expect(showOut).toContain('claude:2.1.220');
    expect(showOut).toContain('model opus-5');
  });

  it('lists all defaults when given no selector', () => {
    runAgents(home, ['set', 'claude@2.1.220', '--model', 'opus-5']);
    const listOut = runAgents(home, ['set']);
    expect(listOut).toContain('Agent Defaults');
    expect(listOut).toContain('claude:2.1.220');
  });

  it('errors (does not silently drop flags) when a selector is omitted but flags are given', () => {
    let err: { status?: number; stderr?: string; stdout?: string } | undefined;
    try {
      runAgents(home, ['set', '--model', 'opus-5']);
    } catch (e) {
      err = e as { status?: number; stderr?: string; stdout?: string };
    }
    expect(err).toBeDefined();
    expect(err?.status).toBe(1);
    expect(String(err?.stderr) + String(err?.stdout)).toContain('Selector is required');
    // and nothing was written
    expect(fs.existsSync(path.join(home, '.agents', 'agents.yaml'))).toBe(false);
  });

  it('reports no default set for an unconfigured selector', () => {
    const out = runAgents(home, ['set', 'claude@9.9.9']);
    expect(out).toContain('No default set for claude:9.9.9');
  });
});
