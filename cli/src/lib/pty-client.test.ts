import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  buildPtyStartFailureMessage,
  getServerSpawnArgs,
  isBunStandaloneExecutable,
  readRecentLogLines,
} from './pty-client.js';

/**
 * The standalone-compile test needs `bun build --compile` to (a) exist and (b)
 * produce a runnable standalone that resolves a relative import of the repo
 * source. On GitHub macOS CI that fixture fails: `os.tmpdir()` lives under the
 * `/var` -> `/private/var` symlink, and bun resolves the compiled fixture to
 * its realpath before applying the relative import, so the import path breaks
 * (an extra `../` level). Probe the exact compile+run round-trip once at load
 * time; skip the test when it can't produce a working standalone here, so the
 * test still runs wherever bun-compile works (Linux CI, local without the
 * symlink quirk).
 */
function bunStandaloneCompileWorks(): boolean {
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pty-compile-probe-'));
    const fixture = path.join(dir, 'probe.ts');
    const outfile = path.join(dir, process.platform === 'win32' ? 'probe.exe' : 'probe');
    const ptyClientImport = path.relative(dir, path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-client.ts'));
    fs.writeFileSync(fixture, [
      `import { isBunStandaloneExecutable } from ${JSON.stringify(ptyClientImport.startsWith('.') ? ptyClientImport : `./${ptyClientImport}`)};`,
      'console.log(JSON.stringify({ ok: isBunStandaloneExecutable() }));',
    ].join('\n'), 'utf-8');
    execFileSync('bun', ['build', fixture, '--compile', '--outfile', outfile], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const res = spawnSync(outfile, [], { encoding: 'utf-8' });
    return res.status === 0;
  } catch {
    return false;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const standaloneCompileWorks = bunStandaloneCompileWorks();

describe('getServerSpawnArgs', () => {
  it('runs the co-shipped dist/index.js under real node when standalone (native addons load there, not in the bun binary)', () => {
    // #315 regression: a Bun --compile standalone can't require() node-pty's
    // pty.node, so the sidecar must run via a real node + the dist/index.js that
    // ships beside the binary.
    // getServerSpawnArgs builds the sidecar path with path.join, which emits
    // native separators — derive the fixture the same way so the fileExists
    // seam and the assertion match on Windows too.
    const distIndex = path.join('/opt/agents/dist/bin', '..', 'index.js');
    const spawn = getServerSpawnArgs({
      isStandaloneExecutable: true,
      execPath: '/opt/agents/dist/bin/agents',
      resolveNode: () => '/usr/local/bin/node',
      fileExists: (p) => p === distIndex,
    });

    expect(spawn).toEqual({
      bin: '/usr/local/bin/node',
      args: [distIndex, 'pty', '_server'],
    });
  });

  it('falls back to running the standalone binary itself when no node is found', () => {
    const spawn = getServerSpawnArgs({
      isStandaloneExecutable: true,
      execPath: '/opt/agents/dist/bin/agents',
      resolveNode: () => undefined,
      fileExists: () => true,
    });

    expect(spawn).toEqual({ bin: process.execPath, args: ['pty', '_server'] });
  });

  it('falls back to the binary when node exists but no co-shipped dist/index.js', () => {
    const spawn = getServerSpawnArgs({
      isStandaloneExecutable: true,
      execPath: '/opt/agents/dist/bin/agents',
      resolveNode: () => '/usr/local/bin/node',
      fileExists: () => false,
    });

    expect(spawn).toEqual({ bin: process.execPath, args: ['pty', '_server'] });
  });

  it('detects Bun standalone execution from the embedded module URL', () => {
    expect(isBunStandaloneExecutable('file:///$bunfs/root/pty-client.ts')).toBe(true);
    expect(isBunStandaloneExecutable('file:///opt/agents/dist/lib/pty-client.js')).toBe(false);
  });

  it.skipIf(!standaloneCompileWorks)('auto-detects a real bun build --compile executable', ({ skip }) => {
    // Belt-and-suspenders: the release matrix has shown `it.skipIf` failing to
    // keep a test off a runner, so also skip explicitly at runtime.
    if (!standaloneCompileWorks) {
      skip();
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pty-standalone-test-'));
    const fixturePath = path.join(dir, 'standalone-spawn-fixture.ts');
    const outfile = path.join(dir, process.platform === 'win32' ? 'standalone-spawn-fixture.exe' : 'standalone-spawn-fixture');
    const ptyClientImport = path.relative(dir, path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-client.ts'));
    fs.writeFileSync(fixturePath, [
      `import { getServerSpawnArgs, isBunStandaloneExecutable } from ${JSON.stringify(ptyClientImport.startsWith('.') ? ptyClientImport : `./${ptyClientImport}`)};`,
      'const spawn = getServerSpawnArgs();',
      'console.log(JSON.stringify({ spawn, standalone: isBunStandaloneExecutable(), execPath: process.execPath }));',
    ].join('\n'), 'utf-8');

    execFileSync('bun', ['build', fixturePath, '--compile', '--outfile', outfile], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = spawnSync(outfile, [], { encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout.trim()) as {
      spawn: { bin: string; args: string[] };
      standalone: boolean;
      execPath: string;
    };
    expect(payload.standalone).toBe(true);
    expect(payload.spawn).toEqual({
      bin: payload.execPath,
      args: ['pty', '_server'],
    });
  });
});

describe('readRecentLogLines', () => {
  it('returns the tail of the real log file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pty-client-test-'));
    const logPath = path.join(dir, 'logs.jsonl');
    fs.writeFileSync(logPath, ['one', 'two', 'three', ''].join('\n'), 'utf-8');

    expect(readRecentLogLines(logPath, 2)).toEqual(['two', 'three']);
  });
});

describe('buildPtyStartFailureMessage', () => {
  it('includes process exit, readiness, and recent log evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pty-client-test-'));
    const logPath = path.join(dir, 'logs.jsonl');
    fs.writeFileSync(
      logPath,
      [
        "innerError Error: Cannot find module '../build/Debug/pty.node'",
        'node-pty (@homebridge/node-pty-prebuilt-multiarch) is required for PTY support.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const message = buildPtyStartFailureMessage({
      timeoutMs: 5000,
      spawn: { bin: '/usr/local/bin/agents', args: ['pty', '_server'] },
      exit: { code: 1, signal: null },
      lastReadinessError: new Error('PTY server socket not found. Is the server running?'),
      logPath,
    });

    expect(message).toContain('PTY server failed to start within 5 seconds.');
    expect(message).toContain('Spawned: "/usr/local/bin/agents" "pty" "_server"');
    expect(message).toContain('PTY server process exited with code 1 before listening.');
    expect(message).toContain('Last readiness error: PTY server socket not found. Is the server running?');
    expect(message).toContain(`Log: ${logPath}`);
    expect(message).toContain("Cannot find module '../build/Debug/pty.node'");
    expect(message).toContain('node-pty (@homebridge/node-pty-prebuilt-multiarch) is required for PTY support.');
  });

  it('says when no log output exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pty-client-test-'));
    const logPath = path.join(dir, 'missing-logs.jsonl');

    const message = buildPtyStartFailureMessage({
      timeoutMs: 5000,
      spawn: { bin: 'agents', args: ['pty', '_server'] },
      logPath,
    });

    expect(message).toContain(`Log: ${logPath}`);
    expect(message).toContain('No PTY server log output was written.');
  });
});
