import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPtyStartFailureMessage,
  getServerSpawnArgs,
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
