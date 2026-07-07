/**
 * End-to-end shim verification: write a real script, generate the shim that
 * wraps it, invoke the shim with `bash` + stdin, then verify cache hits/misses
 * are correctly served on subsequent calls and that the events JSONL accrues.
 *
 * No mocking — this exercises the actual bash codepath every Claude/Codex
 * registration goes through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateHookShim, type HookShimPaths } from './cache.js';

describe('generated shim — bash execution', () => {
  let tmpHome: string;
  let scriptPath: string;
  let callCounterFile: string;
  let paths: HookShimPaths;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-integ-'));
    // Explicit per-test path bag — state.ts captures HOME at module load,
    // so mutating process.env.HOME won't redirect getHookCacheDir(). The
    // shim accepts overrides for exactly this reason.
    paths = {
      shimsDir: path.join(tmpHome, 'shims'),
      cacheDir: path.join(tmpHome, 'cache'),
      logsDir: path.join(tmpHome, 'logs'),
    };

    // A real bash script the shim will invoke. It increments a counter file
    // and prints the current count — lets the test distinguish hits (cache
    // serves old output) from misses (counter advances).
    callCounterFile = path.join(tmpHome, 'counter');
    fs.writeFileSync(callCounterFile, '0');
    scriptPath = path.join(tmpHome, 'real-hook.sh');
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
read -r line
count=$(cat ${JSON.stringify(callCounterFile)})
count=$((count + 1))
echo "$count" > ${JSON.stringify(callCounterFile)}
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

  it('caches stdout — second call within ttl reuses the cached output (no re-invocation)', () => {
    const shim = generateHookShim({
      name: 'counter-hook',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths,
    });

    const first = runShim(shim, '{}');
    expect(first.stdout.trim()).toBe('call=1');
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('1');

    const second = runShim(shim, '{}');
    expect(second.stdout.trim()).toBe('call=1');
    // Counter did NOT advance — proves the real script was not re-invoked.
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('1');
  });

  it('re-runs the script when the cache file is older than ttl', () => {
    const shim = generateHookShim({
      name: 'short-ttl-hook',
      scriptPath,
      cache: { ttl: 1, key: 'global', prefetch: 'none' },
      paths,
    });

    const first = runShim(shim, '{}');
    expect(first.stdout.trim()).toBe('call=1');

    // Backdate the cache file to force a TTL miss without waiting.
    const cacheFile = path.join(paths.cacheDir!, 'short-ttl-hook.out');
    expect(fs.existsSync(cacheFile)).toBe(true);
    const past = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(cacheFile, past, past);

    const second = runShim(shim, '{}');
    expect(second.stdout.trim()).toBe('call=2');
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('2');
  });

  it('appends a hook.fire event to the daily JSONL on every fire', () => {
    const shim = generateHookShim({
      name: 'logged-hook',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths,
    });

    runShim(shim, '{}');
    runShim(shim, '{}');

    const files = fs.readdirSync(paths.logsDir!).filter(f => f.startsWith('events-'));
    expect(files.length).toBe(1);
    const lines = fs.readFileSync(path.join(paths.logsDir!, files[0]), 'utf-8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].event).toBe('hook.fire');
    expect(lines[0].hook).toBe('logged-hook');
    expect(lines[0].cache).toBe('miss');
    expect(lines[1].cache).toBe('hit');
    expect(typeof lines[0].ms).toBe('number');
  });

  it('per-cwd key produces distinct cache files keyed on stdin cwd', () => {
    const shim = generateHookShim({
      name: 'per-cwd-hook',
      scriptPath,
      cache: { ttl: 300, key: 'per-cwd', prefetch: 'none' },
      paths,
    });

    // Two different cwds → two cache files → two real invocations.
    const a = runShim(shim, JSON.stringify({ cwd: '/some/repo/a' }));
    const b = runShim(shim, JSON.stringify({ cwd: '/some/repo/b' }));
    expect(a.stdout.trim()).toBe('call=1');
    expect(b.stdout.trim()).toBe('call=2');

    // Same cwd again → cache hit, no advance.
    const a2 = runShim(shim, JSON.stringify({ cwd: '/some/repo/a' }));
    expect(a2.stdout.trim()).toBe('call=1');
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('2');
  });
});
