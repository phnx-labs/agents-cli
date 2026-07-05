import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { isAlive, killTree, backgroundSpawnOptions } from './process.js';

describe('isAlive', () => {
  it('is true for the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('is false for invalid pids', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });

  it('is false for a pid that is almost certainly not running', () => {
    // 2^30 is well above any realistic live PID on Linux/macOS/Windows.
    expect(isAlive(1 << 30)).toBe(false);
  });
});

describe('killTree', () => {
  it('terminates a running process', async () => {
    // A child that would otherwise live forever — killTree must actually end it.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    killTree(pid);

    for (let i = 0; i < 100 && isAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isAlive(pid)).toBe(false);
  });

  it('is a no-op for invalid pids (never throws)', () => {
    expect(() => killTree(0)).not.toThrow();
    expect(() => killTree(-1)).not.toThrow();
  });
});

describe('backgroundSpawnOptions', () => {
  it('uses a hidden console instead of detach on win32', () => {
    // CreateProcess ignores CREATE_NO_WINDOW under DETACHED_PROCESS, and a
    // console-less child makes every console descendant flash a visible
    // window — so on Windows the two options must never be combined.
    expect(backgroundSpawnOptions('win32')).toEqual({ detached: false, windowsHide: true });
  });

  it('detaches into its own process group on POSIX', () => {
    expect(backgroundSpawnOptions('darwin')).toEqual({ detached: true, windowsHide: false });
    expect(backgroundSpawnOptions('linux')).toEqual({ detached: true, windowsHide: false });
  });

  it('a child spawned with the current-platform options outlives its parent and stays killable', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { ...backgroundSpawnOptions(), stdio: 'ignore' },
    );
    child.unref();
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    killTree(pid);
    for (let i = 0; i < 100 && isAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isAlive(pid)).toBe(false);
  });
});
