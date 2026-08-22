/**
 * RUSH-3028: a probed binary that forks its own child (the copilot npm
 * wrapper forking its platform-binary downloader) must not leave that
 * grandchild alive after the probe settles — the survivor keeps writing into
 * the probe-time $HOME and races test teardown rm (ENOTEMPTY). These tests
 * drive REAL process trees: a shell parent forks a writer grandchild, and we
 * assert the whole group is dead once the probe returns. They fail on
 * ungated spawns (plain execFile/spawnSync): the grandchild survives there.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probeCapture } from './probe.js';

const posixOnly = describe.skipIf(process.platform === 'win32');

function writeForker(dir: string, opts: { parentExits: boolean }): string {
  // The grandchild records its pid, then writes forever at 50ms cadence.
  // The parent either exits 0 immediately (copilot shape: fork-and-return)
  // or sleeps past every probe timeout (slow-binary shape).
  const script = path.join(dir, 'forker.sh');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `( echo $$ > "${dir}/grandchild.pid.tmp"; mv "${dir}/grandchild.pid.tmp" "${dir}/grandchild.pid"`,
      `  while :; do echo tick >> "${dir}/writes.log"; sleep 0.05; done ) &`,
      'echo 1.2.3',
      opts.parentExits ? 'exit 0' : 'sleep 60',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(script, 0o755);
  return script;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readGrandchildPid(dir: string): Promise<number> {
  const p = path.join(dir, 'grandchild.pid');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) {
      const pid = parseInt(fs.readFileSync(p, 'utf-8').trim(), 10);
      if (!isNaN(pid)) return pid;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('grandchild never recorded its pid');
}

async function expectDeadSoon(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* best-effort cleanup before failing */
  }
  expect.fail(`grandchild ${pid} survived the probe — the process group was not reaped`);
}

posixOnly('probeCapture (RUSH-3028: nothing a probe spawns outlives it)', () => {
  it('reaps the grandchild when the probed parent exits cleanly (copilot fork-and-return shape)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-reap-'));
    try {
      const script = writeForker(dir, { parentExits: true });
      const { stdout } = await probeCapture(script, [], 3000);
      expect(stdout).toContain('1.2.3');
      // The reap can land before the grandchild records its pid, so assert on
      // the leak itself: once the probe has settled, WRITES INTO THE DIR MUST
      // CEASE. On ungated code the grandchild keeps appending every 50ms for
      // 60s and this size check fails.
      const log = path.join(dir, 'writes.log');
      const sizeOf = (): number => (fs.existsSync(log) ? fs.statSync(log).size : 0);
      await new Promise((r) => setTimeout(r, 150));
      const before = sizeOf();
      await new Promise((r) => setTimeout(r, 400));
      expect(sizeOf()).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reaps the grandchild when the probe times out on a hung parent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-reap-'));
    try {
      const script = writeForker(dir, { parentExits: false });
      await expect(probeCapture(script, [], 500)).rejects.toThrow(/timed out/);
      const pid = await readGrandchildPid(dir);
      await expectDeadSoon(pid);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
