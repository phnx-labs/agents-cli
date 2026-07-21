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

describe('getServerSpawnArgs', () => {
  it('runs the compiled standalone binary as the CLI, not as a script interpreter', () => {
    const spawn = getServerSpawnArgs({ isStandaloneExecutable: true });

    expect(spawn).toEqual({
      bin: process.execPath,
      args: ['pty', '_server'],
    });
  });

  it('detects Bun standalone execution from the embedded module URL', () => {
    expect(isBunStandaloneExecutable('file:///$bunfs/root/pty-client.ts')).toBe(true);
    expect(isBunStandaloneExecutable('file:///opt/agents/dist/lib/pty-client.js')).toBe(false);
  });

  it('auto-detects a real bun build --compile executable', () => {
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
