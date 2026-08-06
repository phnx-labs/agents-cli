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

describe('modes command', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-modes-test-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lists modes for claude including plan/edit/auto/skip', () => {
    const out = runAgents(home, ['modes', 'claude']);
    expect(out).toMatch(/claude/i);
    expect(out).toContain('plan');
    expect(out).toContain('edit');
    expect(out).toContain('auto');
    expect(out).toContain('skip');
    expect(out).toContain('--permission-mode');
  });

  it('lists plan/edit/skip for cursor and marks auto unsupported', () => {
    const out = runAgents(home, ['modes', 'cursor']);
    expect(out).toMatch(/cursor/i);
    expect(out).toContain('plan');
    expect(out).toContain('edit');
    expect(out).toContain('skip');
    expect(out).toContain('unsupported: auto');
  });

  it('emits JSON with modes and flags', () => {
    const out = runAgents(home, ['modes', 'claude', '--json']);
    const parsed = JSON.parse(out) as Array<{
      agent: string;
      modes: Array<{ mode: string; flags: string[] }>;
      defaultMode: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].agent).toBe('claude');
    expect(parsed[0].defaultMode).toBe('plan');
    expect(parsed[0].modes.map((m) => m.mode)).toEqual(['plan', 'edit', 'auto', 'skip']);
    expect(parsed[0].modes.find((m) => m.mode === 'skip')!.flags).toContain(
      '--dangerously-skip-permissions',
    );
  });

  it('lists every non-deprecated harness when no agent is given', () => {
    const out = runAgents(home, ['modes']);
    expect(out).toMatch(/Claude/i);
    expect(out).toMatch(/Codex/i);
    expect(out).toMatch(/Cursor/i);
    expect(out).toContain('agents modes <agent>');
  });

  it('errors on an unknown agent', () => {
    let err: { status?: number; stderr?: string; stdout?: string } | undefined;
    try {
      runAgents(home, ['modes', 'not-an-agent']);
    } catch (e) {
      err = e as { status?: number; stderr?: string; stdout?: string };
    }
    expect(err).toBeDefined();
    expect(err?.status).toBe(1);
    expect(String(err?.stderr) + String(err?.stdout)).toMatch(/Unknown agent|not-an-agent|Valid agents/i);
  });
});
