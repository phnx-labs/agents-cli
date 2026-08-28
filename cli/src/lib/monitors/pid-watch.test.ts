import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import { pidLivenessCommand, PID_WATCH_EXITED_TOKEN } from './pid-watch.js';
import { evaluateMonitorOnce } from './engine.js';
import { getMonitorHistoryDir } from './state.js';
import type { MonitorConfig } from './config.js';

describe('pidLivenessCommand (PHNX-3023)', () => {
  it.skipIf(process.platform === 'win32')('reports "running" for a live pid and the exited token for a dead one', () => {
    // process.pid is this test runner — guaranteed alive for the duration of the call.
    const liveOut = execFileSync('/bin/sh', ['-c', pidLivenessCommand(process.pid)], { encoding: 'utf-8' }).trim();
    expect(liveOut).toBe('running');

    // A pid far outside any plausible live range. Real pid, guaranteed dead: reuse
    // a pid this process just spawned and waited on.
    const dead = execFileSync('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!; wait'], { encoding: 'utf-8' });
    const deadPid = Number.parseInt(dead.trim().split('\n')[0], 10);
    const deadOut = execFileSync('/bin/sh', ['-c', pidLivenessCommand(deadPid)], { encoding: 'utf-8' }).trim();
    expect(deadOut).toBe(PID_WATCH_EXITED_TOKEN);
  });
});

/**
 * PHNX-3023's acceptance bar: a REAL watcher, armed on a REAL backgrounded
 * process, must actually fire once that process exits — no exit-based harness
 * hook involved, only the monitor engine's own poll (`evaluateMonitorOnce`,
 * the exact call `MonitorEngine.tick` makes). This is the scenario the ticket
 * names dead: "5 shells still running" that "never wakes up, never alerts".
 */
describe('--watch-pid arms a watcher that actually fires on exit (PHNX-3023)', () => {
  const names: string[] = [];
  afterEach(() => {
    for (const n of names.splice(0)) {
      try { fs.rmSync(getMonitorHistoryDir(n), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it.skipIf(process.platform === 'win32')('stays silent while the watched process is alive, fires once it exits', async () => {
    const child = spawn('sleep', ['30']);
    const pid = child.pid!;
    const name = `test-pidwatch-${process.pid}-${Date.now()}`;
    names.push(name);

    const config: MonitorConfig = {
      name,
      enabled: true,
      source: { type: 'command', command: pidLivenessCommand(pid) },
      condition: { mode: 'match', match: PID_WATCH_EXITED_TOKEN },
      action: { type: 'notify', notifyChannel: 'telegram' },
    };

    // Alive: the source observes 'running', the condition never matches → no fire.
    // This is the "5 shells still running" state — armed, but correctly quiet.
    const aliveOnce = await evaluateMonitorOnce(config);
    expect(aliveOnce.observation?.raw).toBe('running');
    expect(aliveOnce.decision?.fire).toBe(false);

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    // Dead: the exact same poll the daemon's engine runs on its own schedule now
    // observes the exit and fires — the notify/re-invoke path that never ran
    // for an exit-based hook watching a process that outlives the session.
    const deadOnce = await evaluateMonitorOnce(config);
    expect(deadOnce.observation?.raw).toBe(PID_WATCH_EXITED_TOKEN);
    expect(deadOnce.decision?.fire).toBe(true);
    expect(deadOnce.decision?.event?.summary).toContain(PID_WATCH_EXITED_TOKEN);
  });
});
