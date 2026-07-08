/**
 * PID-reuse safety guard for AgentManager.stop().
 *
 * When the OS recycles a teammate's PID to an unrelated process,
 * `process.kill(-pid, 'SIGTERM')` would target whoever now owns that PID's
 * process group. The fix: capture a start-time at spawn and refuse to
 * signal when the live start-time no longer matches.
 *
 * This test wires up an AgentProcess whose pid is the test runner itself
 * (so kill(pid, 0) succeeds) but whose stored start-time is deliberately
 * wrong. stop() must observe the mismatch and skip every kill signal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { AgentManager, AgentProcess, AgentStatus } from '../agents.js';

let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stop-pidreuse-'));
});

afterEach(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('AgentManager.stop() PID-reuse guard', () => {
  it('refuses to signal a PID whose start-time mismatches', async () => {
    const manager = new AgentManager(50, baseDir, 'plan', null, 7);

    // PID = our own test process. kill(pid, 0) succeeds; that's exactly
    // the PID-reuse scenario the guard exists to handle (the slot is
    // occupied by *something*, but not by the agent we spawned).
    const agent = new AgentProcess(
      'agent-fake-id',
      'team-a',
      'claude',
      'noop',
      null,
      'plan',
      process.pid,
      AgentStatus.RUNNING,
      new Date(),
      null,
      baseDir,
    );
    // Stored start-time is bogus — captureProcessStartTime() on our PID
    // will return the real value, which won't match. That mismatch is
    // what stop() must catch.
    agent.startTime = 'BOGUS-START-TIME-NEVER-MATCHES';

    manager.registerAgent(agent);

    // Spy on process.kill so we can prove no signal escaped. We allow the
    // existence probe (signal === 0) since isProcessAlive() relies on it,
    // but SIGTERM/SIGKILL must never be sent.
    const killSpy = vi.spyOn(process, 'kill');

    const result = await manager.stop('agent-fake-id');
    expect(result).toBe(true);
    expect(agent.status).toBe(AgentStatus.STOPPED);
    expect(agent.completedAt).toBeInstanceOf(Date);

    const lethalCalls = killSpy.mock.calls.filter(
      ([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL'
    );
    expect(lethalCalls).toEqual([]);
  });

  it('reports isProcessAlive() === false when start-time mismatches', () => {
    const agent = new AgentProcess(
      'agent-fake-id-2',
      'team-b',
      'claude',
      'noop',
      null,
      'plan',
      process.pid,
      AgentStatus.RUNNING,
    );
    agent.startTime = 'BOGUS-START-TIME-NEVER-MATCHES';
    expect(agent.isProcessAlive()).toBe(false);
  });
});
