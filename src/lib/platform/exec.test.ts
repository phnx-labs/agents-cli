import { describe, it, expect } from 'vitest';
import { whichCommand, findExecutable, needsWindowsShell } from './exec.js';

describe('whichCommand', () => {
  it('is `where` on win32, `which` elsewhere', () => {
    expect(whichCommand('win32')).toBe('where');
    expect(whichCommand('darwin')).toBe('which');
    expect(whichCommand('linux')).toBe('which');
  });
});

describe('findExecutable', () => {
  it('resolves a real executable to an absolute path on the current platform', () => {
    // `node` is guaranteed present in CI and dev.
    const p = findExecutable('node');
    expect(p).toBeTruthy();
    expect(p!.length).toBeGreaterThan(0);
    expect(p).toMatch(/node/i);
  });

  it('returns null for a name that does not exist', () => {
    expect(findExecutable('definitely-not-a-real-binary-xyz123')).toBeNull();
  });
});

describe('needsWindowsShell', () => {
  it('is always false off Windows, even for .cmd or bare names', () => {
    expect(needsWindowsShell('npm', 'linux')).toBe(false);
    expect(needsWindowsShell('npm.cmd', 'linux')).toBe(false);
    expect(needsWindowsShell('/usr/bin/node', 'darwin')).toBe(false);
  });

  it('on win32, needs the shell for .cmd/.bat wrappers (case-insensitive)', () => {
    expect(needsWindowsShell('C:\\Program Files\\nodejs\\npm.cmd', 'win32')).toBe(true);
    expect(needsWindowsShell('C:\\tools\\bun.CMD', 'win32')).toBe(true);
    expect(needsWindowsShell('C:\\x\\run.bat', 'win32')).toBe(true);
  });

  it('on win32, needs the shell for a bare (PATHEXT-resolved) command name', () => {
    expect(needsWindowsShell('npm', 'win32')).toBe(true);
    expect(needsWindowsShell('bun', 'win32')).toBe(true);
  });

  it('on win32, a direct absolute .exe does NOT need the shell', () => {
    expect(needsWindowsShell('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(false);
  });
});
