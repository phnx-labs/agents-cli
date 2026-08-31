/**
 * Real git transport coverage for the daemon shared store.
 *
 * These tests use actual repositories, commits, fetches, rebases, and pushes.
 * The propagation case has two independent checkouts so it fails if the daemon
 * only reads/writes one local directory (the PHNX-3609 review regression).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { consumeUsageSnapshotsFromSharedStore, publishUsageSnapshotToSharedStore } from './accounting/usage-sync.js';
import { readClaudeUsageCache, type CachedUsageSnapshot } from './accounting/usage.js';
import { updateFleetSharedDeviceState } from './fleet-shared-state.js';
import { syncFleetSharedStateRepo } from './fleet-shared-repo-sync.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fleet-repo-sync-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function configureIdentity(repo: string): void {
  git(repo, ['config', 'user.email', 'fleet-sync-test@example.invalid']);
  git(repo, ['config', 'user.name', 'Fleet Sync Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
}

function row(capturedAt: string, usedPercent: number): CachedUsageSnapshot {
  return {
    capturedAt,
    windows: [{
      key: 'five_hour',
      label: 'Session',
      shortLabel: 'S',
      usedPercent,
      resetsAt: null,
      windowMinutes: 300,
    }],
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('syncFleetSharedStateRepo (real git)', () => {
  it('publishes in one checkout and a worker consumes after a real remote push/pull', async () => {
    const root = tempDir();
    const remote = path.join(root, 'remote.git');
    const publisher = path.join(root, 'publisher');
    const worker = path.join(root, 'worker');
    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    git(root, ['clone', remote, publisher]);
    configureIdentity(publisher);
    fs.writeFileSync(path.join(publisher, 'README.md'), 'fleet store\n', 'utf-8');
    git(publisher, ['add', 'README.md']);
    git(publisher, ['commit', '-m', 'seed user store']);
    git(publisher, ['push', 'origin', 'main']);
    git(root, ['clone', remote, worker]);
    configureIdentity(worker);

    const sourceCache = path.join(root, 'source-cache.json');
    const workerCache = path.join(root, 'worker-cache.json');
    fs.writeFileSync(
      sourceCache,
      JSON.stringify({ 'claude:org=alpha': row('2026-08-30T20:00:00.000Z', 64) }),
      'utf-8',
    );
    expect(publishUsageSnapshotToSharedStore({
      userAgentsDir: publisher,
      cachePath: sourceCache,
      role: 'personal',
      device: 'zion',
    })).toMatchObject({ published: true, changed: true, error: null });

    const published = await syncFleetSharedStateRepo({
      userAgentsDir: publisher,
      device: 'zion',
      timeoutMs: 10_000,
      lockPath: path.join(root, 'publisher.lock-target'),
    });
    expect(published).toMatchObject({ success: true, committed: true, timedOut: false, error: null });

    // The worker owns a different file. Its transport must first deliver the
    // publisher commit into this separate checkout, then push its own verdict.
    updateFleetSharedDeviceState('worker-a', { auth: { status: 'missing' } }, worker);
    const delivered = await syncFleetSharedStateRepo({
      userAgentsDir: worker,
      device: 'worker-a',
      timeoutMs: 10_000,
      lockPath: path.join(root, 'worker.lock-target'),
    });
    expect(delivered).toMatchObject({ success: true, committed: true, timedOut: false, error: null });

    const consumed = consumeUsageSnapshotsFromSharedStore({
      userAgentsDir: worker,
      cachePath: workerCache,
      role: 'worker',
      device: 'worker-a',
      roles: { zion: 'personal', 'worker-a': 'worker' },
    });
    expect(consumed).toEqual({ sources: ['zion'], merged: 1, skipped: null, errors: [] });
    expect(readClaudeUsageCache(
      'claude:org=alpha',
      workerCache,
      new Date('2026-08-30T20:01:00.000Z'),
    )?.windows[0].usedPercent).toBe(64);

    const remoteLog = git(root, ['--git-dir', remote, 'log', '--format=%s', 'main']);
    expect(remoteLog).toContain('chore(devices): publish zion daemon state');
    expect(remoteLog).toContain('chore(devices): publish worker-a daemon state');
  });

  it('refuses to push and removes conflict markers when an autostash pop conflicts', async () => {
    const root = tempDir();
    const remote = path.join(root, 'remote.git');
    const publisher = path.join(root, 'publisher');
    const worker = path.join(root, 'worker');
    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    git(root, ['clone', remote, publisher]);
    configureIdentity(publisher);
    fs.writeFileSync(path.join(publisher, 'shared.txt'), 'base\n', 'utf-8');
    git(publisher, ['add', 'shared.txt']);
    git(publisher, ['commit', '-m', 'seed shared file']);
    git(publisher, ['push', 'origin', 'main']);
    git(root, ['clone', remote, worker]);
    configureIdentity(worker);

    // The owned file is dirty and must be committed locally. The unrelated
    // tracked edit is what --autostash protects while the peer advances it.
    updateFleetSharedDeviceState('worker-a', { auth: { status: 'ready' } }, worker);
    fs.writeFileSync(path.join(worker, 'shared.txt'), 'worker local edit\n', 'utf-8');
    fs.writeFileSync(path.join(publisher, 'shared.txt'), 'upstream edit\n', 'utf-8');
    git(publisher, ['add', 'shared.txt']);
    git(publisher, ['commit', '-m', 'peer edits shared file']);
    git(publisher, ['push', 'origin', 'main']);

    const result = await syncFleetSharedStateRepo({
      userAgentsDir: worker,
      device: 'worker-a',
      timeoutMs: 10_000,
      lockPath: path.join(root, 'conflict.lock-target'),
    });

    expect(result).toMatchObject({ success: false, committed: true, pushed: false, timedOut: false });
    expect(result.error).toMatch(/autostash pop conflicted.*push refused.*stash@\{0\}/i);
    expect(git(worker, ['ls-files', '--unmerged'])).toBe('');
    expect(git(worker, ['status', '--porcelain=v1'])).toBe('');
    const restored = fs.readFileSync(path.join(worker, 'shared.txt'), 'utf-8');
    expect(restored).toBe('upstream edit\n');
    expect(restored).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(git(worker, ['stash', 'list', '--format=%gd%x09%gs'])).toMatch(/^stash@\{0\}\tautostash/m);
    expect(git(worker, ['stash', 'show', '-p', 'stash@{0}'])).toContain('worker local edit');
    expect(git(root, ['--git-dir', remote, 'log', '--format=%s', 'main'])).not.toContain(
      'chore(devices): publish worker-a daemon state',
    );
  });

  it.skipIf(process.platform === 'win32')('bounds a hung git SSH transport while daemon timers keep advancing', async () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '--initial-branch=main']);
    configureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n', 'utf-8');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'seed']);
    git(repo, ['remote', 'add', 'origin', 'ssh://203.0.113.1/repo.git']);
    updateFleetSharedDeviceState('zion', { auth: { status: 'ready' } }, repo);

    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats += 1; }, 20);
    const startedAt = Date.now();
    try {
      const result = await syncFleetSharedStateRepo({
        userAgentsDir: repo,
        device: 'zion',
        timeoutMs: 1_000,
        lockPath: path.join(root, 'timeout.lock-target'),
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/git fetch.*timed out|connect|network|route/i);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(heartbeats).toBeGreaterThanOrEqual(10);
    } finally {
      clearInterval(heartbeat);
    }
  });
});
