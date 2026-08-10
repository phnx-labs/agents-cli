// ReadinessDetector — real-process tests (no mocks).
//
// Spawns a real bash shell with a real long-lived node child (the same shape
// the integration test uses), feeds the shell pid to the detector, and asserts
// it emits the readiness facts the leader would broadcast. The kernel contract
// (a TUI child sits in 'S' state) is what agentReady depends on.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, ChildProcess } from 'child_process';
import { ReadinessDetector, selectAgentFromCandidates } from './readinessDetector';
import { ReadinessFactPayload } from './protocol';

const spawned: ChildProcess[] = [];

function spawnShellWithChild(): number {
  // Subshell forks + execs node which blocks forever, so the shell has a child
  // in interruptible sleep — exactly what an idle agent TUI looks like.
  const shell = spawn('bash', ['-c', '(node -e "setInterval(()=>{}, 1e9)") ; true'], {
    stdio: 'ignore',
  });
  spawned.push(shell);
  return shell.pid!;
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

describe('ReadinessDetector', () => {
  test('emits shellReady then agentReady for an armed real shell pid', async () => {
    const pid = spawnShellWithChild();
    expect(pid).toBeGreaterThan(0);

    const facts: ReadinessFactPayload[] = [];
    const detector = new ReadinessDetector({
      emit: (f) => facts.push(f),
      emitAdoption: () => {},
    });

    try {
      detector.setPids([pid]);
      expect(detector.pidCount).toBe(1);
      // tabReady fires synchronously when the pid is added.
      expect(facts.some((f) => f.event === 'tabReady' && f.pid === pid)).toBe(true);

      detector.armAgent(pid, 'claude', undefined);

      await waitFor(
        () => facts.some((f) => f.event === 'shellReady' && f.pid === pid),
        8000,
        'shellReady',
      );
      // agentReady requires AGENT_MIN_CHILD_RUNTIME (2.5s) + a continuous S-state
      // window (1.5s); allow generous wall-clock.
      await waitFor(
        () => facts.some((f) => f.event === 'agentReady' && f.pid === pid),
        15000,
        'agentReady',
      );
    } finally {
      detector.stop();
    }
  }, 20000);

  test('setPids drops a pid that left the snapshot', async () => {
    const pid = spawnShellWithChild();
    const detector = new ReadinessDetector({ emit: () => {}, emitAdoption: () => {} });
    try {
      detector.setPids([pid]);
      expect(detector.pidCount).toBe(1);
      detector.setPids([]);
      expect(detector.pidCount).toBe(0);
    } finally {
      detector.stop();
    }
  });

  test('noteSessionFile fast-paths agentReady when the filename carries the armed sessionId', async () => {
    const pid = spawnShellWithChild();
    const sessionId = '7b1cf038-8761-4e46-af43-5336e7e5a776';
    const facts: ReadinessFactPayload[] = [];
    const detector = new ReadinessDetector({
      emit: (f) => facts.push(f),
      emitAdoption: () => {},
    });
    try {
      detector.setPids([pid]);
      detector.armAgent(pid, 'claude', sessionId);
      // The session file appears before the slow process-state probe completes.
      detector.noteSessionFile(`${sessionId}.jsonl`);
      await waitFor(
        () => facts.some((f) => f.event === 'agentReady' && f.pid === pid),
        2000,
        'fast-path agentReady',
      );
    } finally {
      detector.stop();
    }
  }, 10000);
});

// The gate that stops a Claude tab from adopting a nested codex session on
// reload (Strategy 0 in scanExisting). Pure over ordered BFS candidates — no
// process probing, no mocks.
describe('selectAgentFromCandidates — agent-type gating', () => {
  const claudeId = '11111111-1111-4111-8111-111111111111';
  const codexId = '22222222-2222-4222-8222-222222222222';
  // A Claude tab whose shell also has a nested codex descendant, shallower.
  const mixedTree = [
    { childPid: 100, args: `codex --session-id ${codexId}` },
    { childPid: 200, args: `claude --session-id ${claudeId}` },
  ];

  test('wanting claude skips the shallower codex and returns the claude id', () => {
    const m = selectAgentFromCandidates(mixedTree, 'claude');
    expect(m).not.toBeNull();
    expect(m!.agentKey).toBe('claude');
    expect(m!.childPid).toBe(200);
    expect(m!.sessionId).toBe(claudeId);
  });

  test('wanting codex returns the codex id from the same tree', () => {
    const m = selectAgentFromCandidates(mixedTree, 'codex');
    expect(m!.agentKey).toBe('codex');
    expect(m!.sessionId).toBe(codexId);
  });

  test('no wanted agent keeps first-of-any-type (unchanged adoption behavior)', () => {
    const m = selectAgentFromCandidates(mixedTree);
    expect(m!.agentKey).toBe('codex');
    expect(m!.sessionId).toBe(codexId);
  });

  test('returns null when the wanted agent is absent — no wrong-agent fallback', () => {
    expect(selectAgentFromCandidates([{ childPid: 100, args: `codex --session-id ${codexId}` }], 'claude')).toBeNull();
    expect(selectAgentFromCandidates([], 'claude')).toBeNull();
  });

  test('resumed claude (--resume) is matched under the agent gate', () => {
    const m = selectAgentFromCandidates(
      [{ childPid: 300, args: `claude --resume ${claudeId}` }],
      'claude',
    );
    expect(m!.agentKey).toBe('claude');
    expect(m!.sessionId).toBe(claudeId);
  });
});
