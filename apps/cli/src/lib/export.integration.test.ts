import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `agents export` is the exit door for `--isolated`: it copies a sandboxed install's
// config out to the user's real ~/.<agent> so they can keep their settings and delete
// agents-cli. Drives the real CLI against a throwaway HOME — no mocking — because the
// whole feature is filesystem behavior (additive merge, conflict siblings, receipt).
describe.skipIf(process.platform === 'win32')('agents export', () => {
  let home: string;
  const V = '9.9.4';
  const RECEIPT = '.agents-cli-export.json';
  const SUFFIX = '.from-agents-cli';

  const versionDir = (v = V) => path.join(home, '.agents', '.history', 'versions', 'codex', v);
  const isolatedConfig = (v = V) => path.join(versionDir(v), 'home', '.codex');
  const realConfig = () => path.join(home, '.codex');
  const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf-8');
  const receipt = () => JSON.parse(read(realConfig(), RECEIPT));

  function plantIsolated(v = V, { isolated = true } = {}) {
    const binDir = path.join(versionDir(v), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    // isVersionInstalled resolves the launch binary, so the fixture needs a real file.
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'codex'), 0o755);
    fs.mkdirSync(path.join(isolatedConfig(v), 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(isolatedConfig(v), 'config.toml'), 'model = "sandboxed"\n');
    fs.writeFileSync(path.join(isolatedConfig(v), 'prompts', 'review.md'), '# review\n');
    if (isolated) fs.writeFileSync(path.join(versionDir(v), '.isolated'), '2026-07-30T00:00:00.000Z\n');
  }

  function run(...args: string[]): { out: string; status: number } {
    try {
      const out = execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), ...args], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home, SHELL: '/bin/bash', AGENTS_NO_NUDGE: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8');
      return { out, status: 0 };
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
    }
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-export-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  describe('merge (default)', () => {
    it('NEVER modifies a file the user already has — writes the incoming copy beside it', () => {
      plantIsolated();
      fs.mkdirSync(realConfig(), { recursive: true });
      fs.writeFileSync(path.join(realConfig(), 'config.toml'), '# my note\nmodel = "mine"\n');

      const r = run('export', `codex@${V}`);
      expect(r.status).toBe(0);

      // The user's file is byte-identical, comment and all.
      expect(read(realConfig(), 'config.toml')).toBe('# my note\nmodel = "mine"\n');
      // ...and the incoming one sits next to it for them to diff.
      expect(read(realConfig(), `config.toml${SUFFIX}`)).toContain('sandboxed');
      // A non-colliding file lands normally.
      expect(read(realConfig(), 'prompts', 'review.md')).toContain('# review');
    }, 120_000);

    it('records provenance in the receipt: what was added vs what was left alone', () => {
      plantIsolated();
      fs.mkdirSync(realConfig(), { recursive: true });
      fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "mine"\n');

      expect(run('export', `codex@${V}`).status).toBe(0);
      const rec = receipt();
      expect(rec.mode).toBe('merge');
      expect(rec.from).toContain(`codex@${V}`);
      expect(rec.written).toContain(path.join('prompts', 'review.md'));
      expect(rec.written).not.toContain('config.toml');
      expect(rec.conflicts.map((c: { path: string }) => c.path)).toContain('config.toml');
    }, 120_000);

    it('adds everything when the user has no config at all', () => {
      plantIsolated();
      expect(run('export', `codex@${V}`).status).toBe(0);
      expect(read(realConfig(), 'config.toml')).toContain('sandboxed');
      expect(read(realConfig(), 'prompts', 'review.md')).toContain('# review');
      expect(receipt().conflicts).toEqual([]);
    }, 120_000);

    it('strips symlinks into ~/.agents but keeps the user\'s own', () => {
      plantIsolated();
      const managed = path.join(home, '.agents', 'skills');
      fs.mkdirSync(managed, { recursive: true });
      fs.symlinkSync(managed, path.join(isolatedConfig(), 'skills'));
      const mine = path.join(home, 'my-notes');
      fs.mkdirSync(mine, { recursive: true });
      fs.symlinkSync(mine, path.join(isolatedConfig(), 'notes'));

      expect(run('export', `codex@${V}`).status).toBe(0);
      expect(fs.existsSync(path.join(realConfig(), 'skills'))).toBe(false);
      expect(fs.existsSync(path.join(realConfig(), 'notes'))).toBe(true);
    }, 120_000);
  });

  describe('--replace', () => {
    it('replaces wholesale and backs up the previous config', () => {
      plantIsolated();
      fs.mkdirSync(realConfig(), { recursive: true });
      fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "my-original"\n');

      expect(run('export', `codex@${V}`, '--replace', '--yes').status).toBe(0);
      expect(read(realConfig(), 'config.toml')).toContain('sandboxed');

      const backupsRoot = path.join(home, '.agents', '.history', 'backups', 'codex');
      const stamps = fs.readdirSync(backupsRoot);
      expect(stamps.length).toBeGreaterThan(0);
      expect(read(backupsRoot, stamps[0], 'config.toml')).toContain('my-original');
      expect(receipt().mode).toBe('replace');
    }, 120_000);

    it('refuses without confirmation in a non-interactive shell', () => {
      plantIsolated();
      fs.mkdirSync(realConfig(), { recursive: true });
      fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "mine"\n');

      const r = run('export', `codex@${V}`, '--replace');
      expect(r.status).not.toBe(0);
      expect(read(realConfig(), 'config.toml')).toContain('mine');
    }, 120_000);
  });

  describe('--staged', () => {
    it('activates nothing — the real config is untouched', () => {
      plantIsolated();
      fs.mkdirSync(realConfig(), { recursive: true });
      fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "mine"\n');

      expect(run('export', `codex@${V}`, '--staged').status).toBe(0);
      expect(read(realConfig(), 'config.toml')).toContain('mine');
      const staged = fs.readdirSync(realConfig()).find((n) => n.startsWith('.agents-export-'));
      expect(staged).toBeTruthy();
      expect(read(realConfig(), staged!, 'config.toml')).toContain('sandboxed');
      expect(receipt().mode).toBe('staged');
    }, 120_000);
  });

  describe('refusals and resolution', () => {
    it('--dry-run writes nothing at all, not even a receipt', () => {
      plantIsolated();
      const r = run('export', `codex@${V}`, '--dry-run');
      expect(r.status).toBe(0);
      expect(r.out).toContain('Dry run');
      expect(fs.existsSync(realConfig())).toBe(false);
    }, 120_000);

    it('refuses a NON-isolated version and changes nothing', () => {
      plantIsolated(V, { isolated: false });
      const r = run('export', `codex@${V}`);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('not an isolated install');
      expect(fs.existsSync(realConfig())).toBe(false);
    }, 120_000);

    it('refuses when the real config is a symlink agents-cli already adopted', () => {
      plantIsolated();
      plantIsolated('9.9.5', { isolated: false });
      fs.symlinkSync(isolatedConfig('9.9.5'), realConfig());

      const r = run('export', `codex@${V}`);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('managed by agents-cli');
      expect(read(isolatedConfig('9.9.5'), 'config.toml')).toContain('sandboxed');
      expect(fs.lstatSync(realConfig()).isSymbolicLink()).toBe(true);
    }, 120_000);

    it('rejects --replace together with --staged', () => {
      plantIsolated();
      const r = run('export', `codex@${V}`, '--replace', '--staged');
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('mutually exclusive');
    }, 120_000);

    it('resolves the version when exactly one isolated copy exists', () => {
      plantIsolated();
      expect(run('export', 'codex').status).toBe(0);
      expect(read(realConfig(), 'config.toml')).toContain('sandboxed');
    }, 120_000);
  });
});
