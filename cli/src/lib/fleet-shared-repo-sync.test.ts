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
    expect(await publishUsageSnapshotToSharedStore({
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

  // PHNX-3887: `agents accounts label` writes version-scoped account rows into the
  // central agents.yaml as a plain file write. Publishing only the per-device doc and
  // then rebasing --autostash over the dirty central file destroyed those labels, so
  // every box silently lost its account labels on its next daemon publish.
  it('publishes central agents.yaml so account labels survive the rebase', async () => {
    const root = tempDir();
    const remote = path.join(root, 'remote.git');
    const publisher = path.join(root, 'publisher');
    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    git(root, ['clone', remote, publisher]);
    configureIdentity(publisher);
    fs.writeFileSync(path.join(publisher, 'agents.yaml'), 'accounts: {}\n', 'utf-8');
    git(publisher, ['add', 'agents.yaml']);
    git(publisher, ['commit', '-m', 'seed user store']);
    git(publisher, ['push', 'origin', 'main']);

    // A label write: central agents.yaml modified, left uncommitted.
    fs.writeFileSync(
      path.join(publisher, 'agents.yaml'),
      'accounts:\n  native:\n    abc:\n      name: icloud\n      agent: claude\n',
      'utf-8',
    );
    updateFleetSharedDeviceState('zion', { auth: { status: 'ok' } }, publisher);

    const published = await syncFleetSharedStateRepo({
      userAgentsDir: publisher,
      device: 'zion',
      timeoutMs: 10_000,
      lockPath: path.join(root, 'publisher.lock-target'),
    });
    expect(published).toMatchObject({ success: true, committed: true, error: null });

    // The label must survive on disk AND have reached the remote.
    expect(fs.readFileSync(path.join(publisher, 'agents.yaml'), 'utf-8')).toContain('name: icloud');
    const remoteYaml = git(root, ['--git-dir', remote, 'show', 'main:agents.yaml']);
    expect(remoteYaml).toContain('name: icloud');
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

  it('clears untracked files that collide with incoming tracked files so the rebase is not wedged (PHNX-3923)', async () => {
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

    // Worker clones before the peer/project files exist on origin.
    git(root, ['clone', remote, worker]);
    configureIdentity(worker);

    // A peer publishes files that origin now TRACKS at these paths.
    const identicalRel = 'devices/peer/daemon-state.json';
    const differsRel = 'projects/rush.yaml';
    fs.mkdirSync(path.dirname(path.join(publisher, identicalRel)), { recursive: true });
    fs.writeFileSync(path.join(publisher, identicalRel), '{"auth":"ok"}\n', 'utf-8');
    fs.mkdirSync(path.dirname(path.join(publisher, differsRel)), { recursive: true });
    fs.writeFileSync(path.join(publisher, differsRel), 'canonical: true\n', 'utf-8');
    git(publisher, ['add', identicalRel, differsRel]);
    git(publisher, ['commit', '-m', 'peer publishes shared files']);
    git(publisher, ['push', 'origin', 'main']);

    // The worker holds the SAME paths as UNTRACKED stale local snapshots: one
    // byte-identical to origin, one that differs. Before PHNX-3923 the rebase
    // aborted here ("untracked working tree files would be overwritten").
    fs.mkdirSync(path.dirname(path.join(worker, identicalRel)), { recursive: true });
    fs.writeFileSync(path.join(worker, identicalRel), '{"auth":"ok"}\n', 'utf-8');
    fs.mkdirSync(path.dirname(path.join(worker, differsRel)), { recursive: true });
    fs.writeFileSync(path.join(worker, differsRel), 'stale: local\n', 'utf-8');

    updateFleetSharedDeviceState('worker-a', { auth: { status: 'missing' } }, worker);
    const result = await syncFleetSharedStateRepo({
      userAgentsDir: worker,
      device: 'worker-a',
      timeoutMs: 10_000,
      lockPath: path.join(root, 'worker.lock-target'),
    });

    expect(result).toMatchObject({ success: true, timedOut: false, error: null });
    // The byte-identical collision was dropped losslessly; the differing one
    // was preserved in a backup, not destroyed.
    expect(result.untrackedCleared).toBeGreaterThanOrEqual(1);
    expect(result.untrackedBackedUp).toContain(differsRel);

    // Origin's versions were checked out cleanly in the worker.
    expect(fs.readFileSync(path.join(worker, identicalRel), 'utf-8')).toBe('{"auth":"ok"}\n');
    expect(fs.readFileSync(path.join(worker, differsRel), 'utf-8')).toBe('canonical: true\n');

    // The differing file's original content survives in the sibling backup dir.
    const backupRoot = `${worker}-fleet-sync-backups`;
    const stamps = fs.readdirSync(backupRoot);
    expect(stamps.length).toBe(1);
    expect(fs.readFileSync(path.join(backupRoot, stamps[0], differsRel), 'utf-8')).toBe('stale: local\n');

    // The worker's own state commit still reached origin.
    expect(git(root, ['--git-dir', remote, 'log', '--format=%s', 'main'])).toContain(
      'chore(devices): publish worker-a daemon state',
    );
  });

  it('uses byte identity, not UTF-8 string equality, so distinct invalid bytes are backed up not deleted (PHNX-3923 review)', async () => {
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

    // Two byte strings that both decode to the same UTF-8 string (each trailing
    // byte is an invalid lead byte → U+FFFD) but are NOT byte-identical. A
    // string comparison would call these equal and delete the local copy.
    const rel = 'devices/peer/state.bin';
    const originBytes = Buffer.from([0x7b, 0x7d, 0xff]); // "{}" + 0xFF
    const localBytes = Buffer.from([0x7b, 0x7d, 0xfe]); // "{}" + 0xFE (differs)
    expect(originBytes.toString('utf8')).toBe(localBytes.toString('utf8')); // decode-collision

    fs.mkdirSync(path.dirname(path.join(publisher, rel)), { recursive: true });
    fs.writeFileSync(path.join(publisher, rel), originBytes);
    git(publisher, ['add', rel]);
    git(publisher, ['commit', '-m', 'peer publishes binary state']);
    git(publisher, ['push', 'origin', 'main']);

    fs.mkdirSync(path.dirname(path.join(worker, rel)), { recursive: true });
    fs.writeFileSync(path.join(worker, rel), localBytes);

    updateFleetSharedDeviceState('worker-a', { auth: { status: 'missing' } }, worker);
    const result = await syncFleetSharedStateRepo({
      userAgentsDir: worker,
      device: 'worker-a',
      timeoutMs: 10_000,
      lockPath: path.join(root, 'worker.lock-target'),
    });

    expect(result).toMatchObject({ success: true, error: null });
    // The differing bytes must be PRESERVED (backed up), never deleted as "identical".
    expect(result.untrackedBackedUp).toContain(rel);
    expect(result.untrackedCleared).toBe(0);
    const backupRoot = `${worker}-fleet-sync-backups`;
    const stamps = fs.readdirSync(backupRoot);
    expect(fs.readFileSync(path.join(backupRoot, stamps[0], rel))).toEqual(localBytes);
    // Origin's version is what ends up checked out.
    expect(fs.readFileSync(path.join(worker, rel))).toEqual(originBytes);
  });

  it('hashes raw bytes (--no-filters) so a CRLF/LF filter near-match is backed up, not deleted (PHNX-3923 review)', async () => {
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
    // A machine whose clean filter would normalize line endings. Without
    // --no-filters, hash-object would fold the CRLF file to the LF blob and
    // delete it as "identical"; --no-filters compares raw bytes instead.
    git(worker, ['config', 'core.autocrlf', 'true']);

    const rel = 'devices/peer/notes.txt';
    const originBytes = Buffer.from('a\nb\n', 'utf-8'); // LF (stored on origin)
    const localBytes = Buffer.from('a\r\nb\r\n', 'utf-8'); // CRLF (differs in raw bytes)
    fs.mkdirSync(path.dirname(path.join(publisher, rel)), { recursive: true });
    fs.writeFileSync(path.join(publisher, rel), originBytes);
    git(publisher, ['add', rel]);
    git(publisher, ['commit', '-m', 'peer publishes LF file']);
    git(publisher, ['push', 'origin', 'main']);

    fs.mkdirSync(path.dirname(path.join(worker, rel)), { recursive: true });
    fs.writeFileSync(path.join(worker, rel), localBytes);

    updateFleetSharedDeviceState('worker-a', { auth: { status: 'missing' } }, worker);
    const result = await syncFleetSharedStateRepo({
      userAgentsDir: worker,
      device: 'worker-a',
      timeoutMs: 10_000,
      lockPath: path.join(root, 'worker.lock-target'),
    });

    expect(result).toMatchObject({ success: true, error: null });
    // Raw CRLF bytes differ from the LF blob → preserved in backup, not deleted.
    expect(result.untrackedBackedUp).toContain(rel);
    expect(result.untrackedCleared).toBe(0);
    const backupRoot = `${worker}-fleet-sync-backups`;
    const stamps = fs.readdirSync(backupRoot);
    expect(fs.readFileSync(path.join(backupRoot, stamps[0], rel))).toEqual(localBytes);
  });
});
