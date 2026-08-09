/**
 * Tests for detached `agents pr land` bookkeeping (RUSH-2394).
 *
 * Real path: spawn a short-lived detached child, write state, assert liveness
 * and the one-waiter-per-PR reuse. No network — no GitHub calls.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn as realSpawn, type ChildProcess } from 'child_process';
import {
  prLandSlug,
  prLandStatePath,
  prLandLogPath,
  writePrLandState,
  readPrLandState,
  isPrLandAlive,
  findAlivePrLander,
  spawnDetachedPrLand,
  buildForegroundLandArgs,
  formatDetachResult,
  shouldWarnOrphanedOpenPr,
  formatOrphanedOpenPrWarning,
  type PrLandState,
} from './pr-land-detach.js';
import { isAlive, killTree } from './platform/process.js';

const temps: string[] = [];
const children: ChildProcess[] = [];

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-land-'));
  temps.push(d);
  return d;
}

afterEach(() => {
  for (const c of children) {
    if (c.pid && isAlive(c.pid)) killTree(c.pid);
  }
  children.length = 0;
  for (const d of temps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  temps.length = 0;
});

describe('prLandSlug', () => {
  it('normalizes a GitHub PR URL into owner__repo__number', () => {
    expect(prLandSlug('https://github.com/phnx-labs/agents-cli/pull/2334')).toBe(
      'phnx-labs__agents-cli__2334',
    );
  });

  it('keeps a bare PR number as a safe slug', () => {
    expect(prLandSlug('2334')).toBe('2334');
  });

  it('sanitizes unsafe path characters', () => {
    // Dots are allowed (URL hostnames use them); slashes and other path
    // separators become underscores. Leading `../` therefore becomes `.._`.
    expect(prLandSlug('../evil/42')).toBe('.._evil_42');
    expect(prLandSlug('a/b c')).toBe('a_b_c');
  });
});

describe('buildForegroundLandArgs', () => {
  it('omits --detach so a detached child does not re-detach', () => {
    const args = buildForegroundLandArgs({ pr: '42', interval: 30, skipReview: true, deleteBranch: false });
    expect(args).toEqual(['pr', 'land', '42', '--interval', '30', '--skip-review', '--no-delete-branch']);
    expect(args).not.toContain('--detach');
  });
});

describe('state read/write + liveness', () => {
  it('round-trips state and reports alive for a live pid', () => {
    const history = tempDir();
    // A real short-lived process we can probe.
    const child = realSpawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    child.unref();
    children.push(child);
    expect(child.pid).toBeTruthy();

    const statePath = prLandStatePath('99', history);
    const state: PrLandState = {
      pr: '99',
      pid: child.pid!,
      logPath: prLandLogPath('99', history),
      statePath,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
    };
    writePrLandState(state);
    const loaded = readPrLandState(statePath);
    expect(loaded?.pid).toBe(child.pid);
    expect(isPrLandAlive(loaded)).toBe(true);
    expect(findAlivePrLander('99', history)?.pid).toBe(child.pid);
  });

  it('reports not alive for a dead pid', () => {
    const history = tempDir();
    const statePath = prLandStatePath('7', history);
    writePrLandState({
      pr: '7',
      pid: 999_999_999, // almost certainly not a live process
      logPath: prLandLogPath('7', history),
      statePath,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
    });
    expect(isPrLandAlive(readPrLandState(statePath))).toBe(false);
    expect(findAlivePrLander('7', history)).toBeNull();
  });

  it('returns null for a missing state file', () => {
    const history = tempDir();
    expect(readPrLandState(prLandStatePath('missing', history))).toBeNull();
  });
});

describe('spawnDetachedPrLand', () => {
  it('spawns a detached child, writes state, and reuses a live lander', () => {
    const history = tempDir();
    // Child that idles long enough to probe; launched via the injectable spawn.
    const result = spawnDetachedPrLand({
      pr: '1234',
      cwd: process.cwd(),
      historyDir: history,
      // Real sleep so isAlive is meaningful; the lander's argv is ignored here.
      launch: { command: 'sleep', args: ['60'] },
    });
    expect(result.reused).toBe(false);
    expect(result.pid).toBeGreaterThan(0);
    expect(isAlive(result.pid)).toBe(true);
    expect(fs.existsSync(result.statePath)).toBe(true);
    expect(fs.existsSync(result.logPath)).toBe(true);
    // Track for cleanup.
    children.push({ pid: result.pid } as ChildProcess);

    const again = spawnDetachedPrLand({
      pr: '1234',
      cwd: process.cwd(),
      historyDir: history,
      launch: { command: 'sleep', args: ['60'] },
    });
    expect(again.reused).toBe(true);
    expect(again.pid).toBe(result.pid);
  });

  it('throws when spawn produces no pid', () => {
    const history = tempDir();
    const fakeSpawn = (() => {
      const fake = {
        pid: undefined,
        on() { return fake; },
        unref() { return fake; },
      };
      return fake as unknown as ChildProcess;
    }) as unknown as typeof realSpawn;

    expect(() =>
      spawnDetachedPrLand({
        pr: '1',
        historyDir: history,
        launch: { command: 'no-such-bin-xyz', args: [] },
        spawnFn: fakeSpawn,
      }),
    ).toThrow(/produced no PID/);
  });
});

describe('formatDetachResult', () => {
  it('names the pid and warns against gh pr checks --watch', () => {
    const text = formatDetachResult(
      { pid: 42, logPath: '/tmp/land.log', statePath: '/tmp/state.json', reused: false },
      '2334',
    );
    expect(text).toContain('pid=42');
    expect(text).toContain('2334');
    expect(text).toMatch(/gh pr checks --watch/);
    expect(text).toMatch(/RUSH-2394/);
  });

  it('says already running when reused', () => {
    const text = formatDetachResult(
      { pid: 7, logPath: '/l', statePath: '/s', reused: true },
      '1',
    );
    expect(text).toMatch(/already running/);
  });
});

describe('orphaned open-PR warn classifier', () => {
  it('warns only for OPEN PRs with no alive lander', () => {
    expect(shouldWarnOrphanedOpenPr(null, false)).toBe(false);
    expect(shouldWarnOrphanedOpenPr({ number: 1, url: 'u', state: 'MERGED' }, false)).toBe(false);
    expect(shouldWarnOrphanedOpenPr({ number: 1, url: 'u', state: 'OPEN' }, true)).toBe(false);
    expect(shouldWarnOrphanedOpenPr({ number: 1, url: 'u', state: 'OPEN' }, false)).toBe(true);
    expect(shouldWarnOrphanedOpenPr({ number: 1, url: 'u', state: 'open' }, false)).toBe(true);
  });

  it('formats a warning that points at agents pr land --detach', () => {
    const text = formatOrphanedOpenPrWarning({
      number: 2334,
      url: 'https://github.com/phnx-labs/agents-cli/pull/2334',
      state: 'OPEN',
    });
    expect(text).toMatch(/RUSH-2394/);
    expect(text).toContain('agents pr land --detach 2334');
    expect(text).toContain('https://github.com/phnx-labs/agents-cli/pull/2334');
    expect(text).toMatch(/gh pr checks --watch/);
  });
});
