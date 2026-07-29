import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  enumerateTrackedFiles,
  buildSetupSshArgs,
  buildSetupRsyncArgs,
  copySetupToBox,
  CRABBOX_SSH_USER,
  CRABBOX_SSH_PORT,
} from './setup-copy.js';

/** Make a real git repo with the given files, returning its path. */
function makeGitRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-'));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf-8' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.com']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

describe('enumerateTrackedFiles', () => {
  it('returns only git-tracked files (untracked / gitignored excluded)', () => {
    const dir = makeGitRepo({
      'skills/foo.md': 'x',
      '.gitignore': '.history/\ncache.tmp\n',
      '.history/log.txt': 'noise',
      'cache.tmp': 'noise',
    });
    try {
      spawnSync('git', ['-C', dir, 'add', 'skills/foo.md', '.gitignore']);
      const files = enumerateTrackedFiles(dir).sort();
      expect(files).toEqual(['.gitignore', 'skills/foo.md']);
      // The gitignored / untracked noise is never enumerated.
      expect(files).not.toContain('.history/log.txt');
      expect(files).not.toContain('cache.tmp');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never enumerates .claude or .claude.json even if tracked', () => {
    const dir = makeGitRepo({
      '.claude.json': '{}',
      '.claude/settings.json': '{}',
      'commands/x.md': 'x',
    });
    try {
      spawnSync('git', ['-C', dir, 'add', '-A', '-f']);
      const files = enumerateTrackedFiles(dir);
      expect(files).toContain('commands/x.md');
      expect(files).not.toContain('.claude.json');
      expect(files.some((f) => f.startsWith('.claude/'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-nogit-'));
    try {
      expect(enumerateTrackedFiles(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildSetupSshArgs', () => {
  it('targets crabbox@host:2222 with the hardened ssh baseline', () => {
    const args = buildSetupSshArgs({ host: '203.0.113.5' }, 'agents repo refresh');
    expect(args).toContain('-p');
    expect(args).toContain(String(CRABBOX_SSH_PORT));
    expect(args).toContain(`${CRABBOX_SSH_USER}@203.0.113.5`);
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('BatchMode=yes');
    expect(args.slice(-3)).toEqual(['bash', '-lc', 'agents repo refresh']);
  });

  it('honors a custom user and port', () => {
    const args = buildSetupSshArgs({ host: 'h', user: 'root', port: 22 }, 'echo hi');
    expect(args).toContain('root@h');
    expect(args).toContain('22');
  });
});

describe('buildSetupRsyncArgs', () => {
  it('pushes the file list over ssh to ~/.agents on the box', () => {
    const args = buildSetupRsyncArgs({
      target: { host: '203.0.113.5' },
      filesFrom: '/tmp/list',
      source: '/home/u/.agents',
    });
    expect(args).toContain('-az');
    expect(args).toContain('--files-from');
    expect(args).toContain('/tmp/list');
    expect(args).toContain('--from0');
    // Source gets a trailing slash so contents (not the dir) land in the remote.
    expect(args).toContain('/home/u/.agents/');
    expect(args).toContain(`${CRABBOX_SSH_USER}@203.0.113.5:.agents/`);
    // The -e transport is a single ssh command string carrying the port + baseline.
    const eIdx = args.indexOf('-e');
    expect(eIdx).toBeGreaterThan(-1);
    const sshCmd = args[eIdx + 1];
    expect(sshCmd.startsWith('ssh ')).toBe(true);
    expect(sshCmd).toContain('-p 2222');
    expect(sshCmd).toContain('StrictHostKeyChecking=accept-new');
  });
});

describe('copySetupToBox', () => {
  /** Install fake `rsync` + `ssh` that log argv and exit as configured. */
  function withFakeTransport(
    exit: { rsync: number; ssh: number },
    fn: (ctx: { rsyncLog: string; sshLog: string }) => Promise<void>,
  ): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-fake-'));
    const rsyncLog = path.join(dir, 'rsync.log');
    const sshLog = path.join(dir, 'ssh.log');
    for (const [name, code, log] of [
      ['rsync', exit.rsync, rsyncLog],
      ['ssh', exit.ssh, sshLog],
    ] as const) {
      fs.writeFileSync(
        path.join(dir, name),
        ['#!/bin/sh', `printf "%s\\n" "$*" >> "${log}"`, `exit ${code}`].join('\n'),
        'utf-8',
      );
      fs.chmodSync(path.join(dir, name), 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    return fn({ rsyncLog, sshLog }).finally(() => {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('enumerates tracked files, rsyncs them, then runs agents repo refresh on the box', async () => {
    const repo = makeGitRepo({ 'skills/a.md': 'x', 'commands/b.md': 'y' });
    spawnSync('git', ['-C', repo, 'add', '-A']);
    try {
      await withFakeTransport({ rsync: 0, ssh: 0 }, async ({ rsyncLog, sshLog }) => {
        const result = await copySetupToBox({ host: '203.0.113.7', userAgentsDir: repo });
        expect(result.files.sort()).toEqual(['commands/b.md', 'skills/a.md']);
        expect(result.pushExitCode).toBe(0);
        expect(result.refreshExitCode).toBe(0);
        expect(fs.readFileSync(rsyncLog, 'utf-8')).toContain('crabbox@203.0.113.7:.agents/');
        expect(fs.readFileSync(sshLog, 'utf-8')).toContain('agents repo refresh');
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('skips the refresh when the rsync push fails', async () => {
    const repo = makeGitRepo({ 'skills/a.md': 'x' });
    spawnSync('git', ['-C', repo, 'add', '-A']);
    try {
      await withFakeTransport({ rsync: 23, ssh: 0 }, async ({ sshLog }) => {
        const result = await copySetupToBox({ host: 'h', userAgentsDir: repo });
        expect(result.pushExitCode).toBe(23);
        expect(result.refreshExitCode).toBeNull();
        expect(fs.existsSync(sshLog)).toBe(false); // ssh never invoked
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is a no-op (no rsync, no ssh) when there are no tracked files', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-empty-'));
    spawnSync('git', ['-C', repo, 'init', '-q']);
    try {
      await withFakeTransport({ rsync: 0, ssh: 0 }, async ({ rsyncLog, sshLog }) => {
        const result = await copySetupToBox({ host: 'h', userAgentsDir: repo });
        expect(result.files).toEqual([]);
        expect(result.pushExitCode).toBeNull();
        expect(result.refreshExitCode).toBeNull();
        expect(fs.existsSync(rsyncLog)).toBe(false);
        expect(fs.existsSync(sshLog)).toBe(false);
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
