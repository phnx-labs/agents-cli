/**
 * End-to-end verification of the `matches:` gate baked into the generated shim
 * (issue #744 / RUSH-1506). No mocking — writes a real script, generates the
 * shim that wraps it, invokes the shim with `bash` + a JSON event payload on
 * stdin, and asserts the underlying script runs (fires) or not (skipped) via a
 * counter file. This is the actual bash codepath every Claude/Codex hook fire
 * goes through.
 *
 * A conformance suite additionally cross-checks the shim's fire/skip decision
 * against `shouldFire()` (the TS reference in match.ts) over the same fixtures,
 * so the two implementations can't drift.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateHookShim, type HookShimPaths } from './cache.js';
import { shouldFire } from './match.js';
import type { HookMatches } from '../types.js';

describe('generated shim — matches: gate', () => {
  let tmpHome: string;
  let scriptPath: string;
  let counterFile: string;
  let paths: HookShimPaths;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-match-'));
    paths = {
      shimsDir: path.join(tmpHome, 'shims'),
      cacheDir: path.join(tmpHome, 'cache'),
      logsDir: path.join(tmpHome, 'logs'),
    };
    counterFile = path.join(tmpHome, 'counter');
    fs.writeFileSync(counterFile, '0');
    scriptPath = path.join(tmpHome, 'real-hook.sh');
    // Increments the counter and echoes it. A cache hit or a gate skip means
    // this never runs, so the counter does not advance.
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
cat >/dev/null
count=$(cat ${JSON.stringify(counterFile)})
count=$((count + 1))
echo "$count" > ${JSON.stringify(counterFile)}
echo "call=$count"
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function runShim(shim: string, stdin: string): { stdout: string; exit: number } {
    try {
      const stdout = execFileSync('bash', [shim], { input: stdin, encoding: 'utf-8' });
      return { stdout, exit: 0 };
    } catch (err: any) {
      return { stdout: err.stdout?.toString() ?? '', exit: err.status ?? 1 };
    }
  }

  const counter = () => Number(fs.readFileSync(counterFile, 'utf-8').trim());

  it('skips the script when a non-matching matches: block is set (documented gating)', () => {
    const shim = generateHookShim({
      name: 'gated-skip',
      scriptPath,
      matches: { tool_name: 'Bash' },
      paths,
    });

    const res = runShim(shim, JSON.stringify({ tool_name: 'Read' }));
    // Predicate failed → hook skipped → exit 0, no stdout, counter untouched.
    expect(res.exit).toBe(0);
    expect(res.stdout.trim()).toBe('');
    expect(counter()).toBe(0);
  });

  it('fires the script when the matches: block matches', () => {
    const shim = generateHookShim({
      name: 'gated-fire',
      scriptPath,
      matches: { tool_name: 'Bash' },
      paths,
    });

    const res = runShim(shim, JSON.stringify({ tool_name: 'Bash' }));
    expect(res.stdout.trim()).toBe('call=1');
    expect(counter()).toBe(1);
  });

  it('is unaffected by a hook with no matches block (cache-only shim still fires)', () => {
    const shim = generateHookShim({
      name: 'no-matches',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths,
    });

    const res = runShim(shim, '{}');
    expect(res.stdout.trim()).toBe('call=1');
    expect(counter()).toBe(1);
  });

  it('logs a hook.fire event with cache="skip" when the gate suppresses the fire', () => {
    const shim = generateHookShim({
      name: 'gated-logged',
      scriptPath,
      matches: { cwd_includes: '/nope' },
      paths,
    });

    runShim(shim, JSON.stringify({ cwd: '/home/me/project' }));
    const files = fs.readdirSync(paths.logsDir!).filter(f => f.startsWith('events-'));
    expect(files.length).toBe(1);
    const lines = fs.readFileSync(path.join(paths.logsDir!, files[0]), 'utf-8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].event).toBe('hook.fire');
    expect(lines[0].hook).toBe('gated-logged');
    expect(lines[0].cache).toBe('skip');
    expect(lines[0].exit).toBe(0);
  });

  it('applies the gate BEFORE the cache — a skipped fire never serves or writes cache', () => {
    const shim = generateHookShim({
      name: 'gated-cached',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      matches: { tool_name: 'Bash' },
      paths,
    });

    // Non-matching event → skipped, nothing cached.
    const skipped = runShim(shim, JSON.stringify({ tool_name: 'Read' }));
    expect(skipped.stdout.trim()).toBe('');
    expect(counter()).toBe(0);
    expect(fs.existsSync(path.join(paths.cacheDir!, 'gated-cached.out'))).toBe(false);

    // Matching event → fires and caches; second matching call hits cache.
    const first = runShim(shim, JSON.stringify({ tool_name: 'Bash' }));
    expect(first.stdout.trim()).toBe('call=1');
    const second = runShim(shim, JSON.stringify({ tool_name: 'Bash' }));
    expect(second.stdout.trim()).toBe('call=1');
    expect(counter()).toBe(1);
  });

  describe('conformance with shouldFire() (no drift between shim gate and TS reference)', () => {
    const fixtures: Array<{ name: string; matches: HookMatches; input: Record<string, unknown> }> = [
      { name: 'empty-block', matches: {}, input: { prompt: 'anything' } },
      { name: 'contains-hit', matches: { prompt_contains: '#' }, input: { prompt: 'hi #checkit' } },
      { name: 'contains-miss', matches: { prompt_contains: '#' }, input: { prompt: 'hi' } },
      { name: 'contains-absent', matches: { prompt_contains: '#' }, input: {} },
      { name: 'regex-hit', matches: { prompt_matches: '^debug ' }, input: { prompt: 'debug this' } },
      { name: 'regex-miss', matches: { prompt_matches: '^debug ' }, input: { prompt: 'plan this' } },
      { name: 'regex-invalid', matches: { prompt_matches: '[unclosed' }, input: { prompt: 'x' } },
      { name: 'regex-redos', matches: { prompt_matches: '(.*?)+foo' }, input: { prompt: 'foo' } },
      { name: 'tool-single-hit', matches: { tool_name: 'Bash' }, input: { tool_name: 'Bash' } },
      { name: 'tool-array-hit', matches: { tool_name: ['Bash', 'Write'] }, input: { tool_name: 'Write' } },
      { name: 'tool-miss', matches: { tool_name: ['Bash'] }, input: { tool_name: 'Read' } },
      { name: 'tool-absent', matches: { tool_name: 'Bash' }, input: {} },
      { name: 'args-obj-hit', matches: { tool_args_match: 'rm -rf' }, input: { tool_args: { cmd: 'rm -rf /tmp' } } },
      { name: 'args-str-hit', matches: { tool_args_match: 'foo' }, input: { tool_args: 'foo bar' } },
      { name: 'args-miss', matches: { tool_args_match: 'rm' }, input: { tool_args: { cmd: 'ls' } } },
      { name: 'cwd-hit', matches: { cwd_includes: 'src' }, input: { cwd: '/home/me/src/x' } },
      { name: 'cwd-array-hit', matches: { cwd_includes: ['/work', '/play'] }, input: { cwd: '/home/me/work/x' } },
      { name: 'cwd-miss', matches: { cwd_includes: 'work' }, input: { cwd: '/home/me/play' } },
      { name: 'and-pass', matches: { prompt_contains: '#', tool_name: 'Bash' }, input: { prompt: 'do #foo', tool_name: 'Bash' } },
      { name: 'and-fail', matches: { prompt_contains: '#', tool_name: 'Bash' }, input: { prompt: 'do #foo', tool_name: 'Read' } },
    ];

    for (const fx of fixtures) {
      it(`shim gate matches shouldFire() for ${fx.name}`, () => {
        const before = counter();
        const shim = generateHookShim({
          name: `conf-${fx.name}`,
          scriptPath,
          matches: fx.matches,
          paths,
        });
        runShim(shim, JSON.stringify(fx.input));
        const fired = counter() > before;
        expect(fired).toBe(shouldFire(fx.matches, fx.input as any));
      });
    }
  });
});
