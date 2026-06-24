import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runLoop,
  loopSignalPath,
  readLoopSignal,
  clearLoopSignal,
  type LoopContext,
  type IterationResult,
} from './loop.js';
import type { ExecOptions } from './exec.js';
import type { Checkpoint } from './checkpoint.js';

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-loop-test-'));
}

const baseExec: ExecOptions = {
  agent: 'claude',
  prompt: 'iterate',
  mode: 'skip',
  effort: 'auto',
};

function baseCtx(runDir: string, overrides: Partial<LoopContext> = {}): LoopContext {
  return { runId: 'loop-test', runDir, agent: 'claude', ...overrides };
}

/** A run-fn that records each call and returns a fixed token count + exit 0. */
function recordingRun(tokensPerIter = 0): {
  fn: (o: ExecOptions) => Promise<IterationResult>;
  calls: ExecOptions[];
} {
  const calls: ExecOptions[] = [];
  return {
    calls,
    fn: async (o: ExecOptions) => {
      calls.push(o);
      return { exitCode: 0, tokens: tokensPerIter };
    },
  };
}

const noSleep = async () => {};

describe('runLoop — termination by max_iterations', () => {
  it('runs exactly maxIterations turns then stops with stoppedBy max', async () => {
    const runDir = tmpRunDir();
    const rec = recordingRun();
    const checkpoints: Checkpoint[] = [];
    const result = await runLoop(baseExec, { maxIterations: 3, interval: '0' }, baseCtx(runDir), {
      runIteration: rec.fn,
      sleep: noSleep,
      writeCheckpoint: (c) => checkpoints.push({ ...c }),
    });
    expect(result.iterations).toBe(3);
    expect(result.stoppedBy).toBe('max');
    expect(rec.calls.length).toBe(3);
    // A checkpoint after every iteration.
    expect(checkpoints.length).toBe(3);
    expect(checkpoints[checkpoints.length - 1].iteration).toBe(3);
  });

  it('pins --session-id from iteration 2 onward so the conversation resumes', async () => {
    const runDir = tmpRunDir();
    const rec = recordingRun();
    await runLoop(baseExec, { maxIterations: 3, interval: '0' }, baseCtx(runDir), {
      runIteration: rec.fn,
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    // Every iteration carries a session id; iterations 2+ carry the SAME pinned id.
    const ids = rec.calls.map((c) => c.sessionId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[0]).toBe(ids[1]); // fresh run mints one id reused throughout
  });
});

describe('runLoop — until=signal', () => {
  it('stops with condition-met when the entrypoint writes continue:false', async () => {
    const runDir = tmpRunDir();
    let iter = 0;
    const result = await runLoop(baseExec, { until: 'signal', maxIterations: 10, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => {
        iter++;
        // The "agent" writes the signal AFTER iteration 1 saying "stop".
        if (iter === 1) {
          fs.writeFileSync(loopSignalPath(runDir), JSON.stringify({ continue: false, reason: 'goal reached' }), 'utf-8');
        }
        return { exitCode: 0, tokens: 0 };
      },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.iterations).toBe(1);
    expect(result.stoppedBy).toBe('condition-met');
    expect(result.lastSignal?.reason).toBe('goal reached');
  });

  it('continues while the signal says continue:true, then stops on false', async () => {
    const runDir = tmpRunDir();
    let iter = 0;
    const result = await runLoop(baseExec, { until: 'signal', maxIterations: 10, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => {
        iter++;
        const cont = iter < 3; // stop on the 3rd
        fs.writeFileSync(loopSignalPath(runDir), JSON.stringify({ continue: cont }), 'utf-8');
        return { exitCode: 0, tokens: 0 };
      },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.iterations).toBe(3);
    expect(result.stoppedBy).toBe('condition-met');
  });

  it('fail-closed: an absent signal file stops with condition-met', async () => {
    const runDir = tmpRunDir();
    // run-fn never writes loop-signal.json — absence must be treated as stop.
    const result = await runLoop(baseExec, { until: 'signal', maxIterations: 10, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 0, tokens: 0 }),
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.iterations).toBe(1);
    expect(result.stoppedBy).toBe('condition-met');
    expect(result.lastSignal?.continue).toBe(false);
  });

  it('deletes the signal file between iterations so a stale signal cannot carry over', async () => {
    const runDir = tmpRunDir();
    let iter = 0;
    const seenSignalBeforeRun: boolean[] = [];
    await runLoop(baseExec, { until: 'signal', maxIterations: 3, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => {
        iter++;
        // Record whether a stale signal survived into this iteration's start.
        seenSignalBeforeRun.push(fs.existsSync(loopSignalPath(runDir)));
        fs.writeFileSync(loopSignalPath(runDir), JSON.stringify({ continue: iter < 3 }), 'utf-8');
        return { exitCode: 0, tokens: 0 };
      },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    // The driver clears the signal after reading it, so no iteration ever begins
    // with a leftover signal file present.
    expect(seenSignalBeforeRun).toEqual([false, false, false]);
  });
});

describe('runLoop — budget (token cap)', () => {
  it('stops with budget once cumulative tokens reach the cap', async () => {
    const runDir = tmpRunDir();
    // 400 tokens/iter, cap 1000 → stops after iter 3 (1200 >= 1000).
    const result = await runLoop(baseExec, { budget: 1000, maxIterations: 100, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 0, tokens: 400 }),
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('budget');
    expect(result.iterations).toBe(3);
    expect(result.tokens).toBe(1200);
  });

  it('does not stop on budget when tokens stay under the cap (max wins)', async () => {
    const runDir = tmpRunDir();
    const result = await runLoop(baseExec, { budget: 100000, maxIterations: 2, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 0, tokens: 10 }),
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('max');
    expect(result.tokens).toBe(20);
  });
});

describe('runLoop — error handling', () => {
  it('stops with error and checkpoints when an iteration exits non-zero', async () => {
    const runDir = tmpRunDir();
    let last: Checkpoint | undefined;
    const result = await runLoop(baseExec, { maxIterations: 5, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 2, tokens: 5 }),
      sleep: noSleep,
      writeCheckpoint: (c) => { last = { ...c }; },
    });
    expect(result.stoppedBy).toBe('error');
    expect(result.iterations).toBe(1);
    expect(last?.iteration).toBe(1);
  });

  it('stops with error when an iteration throws', async () => {
    const runDir = tmpRunDir();
    const result = await runLoop(baseExec, { maxIterations: 5, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => { throw new Error('spawn blew up'); },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('error');
    expect(result.iterations).toBe(0);
  });
});

describe('runLoop — resume from checkpoint', () => {
  it('starts at checkpoint.iteration+1 and carries token count forward', async () => {
    const runDir = tmpRunDir();
    const rec = recordingRun(100);
    const checkpoints: Checkpoint[] = [];
    // Simulate a run that already completed 2 iterations (300 tokens), resuming
    // at iteration 3 with maxIterations 4 → runs iterations 3 and 4 only.
    const result = await runLoop(baseExec, { maxIterations: 4, interval: '0' }, baseCtx(runDir, {
      startIteration: 3,
      startTokens: 300,
      sessionId: 'resumed-session-id',
    }), {
      runIteration: rec.fn,
      sleep: noSleep,
      writeCheckpoint: (c) => checkpoints.push({ ...c }),
    });
    // Only 2 NEW iterations executed (3 and 4).
    expect(rec.calls.length).toBe(2);
    expect(result.iterations).toBe(2);
    expect(result.stoppedBy).toBe('max');
    // Token count continued from 300: 300 + 2*100 = 500.
    expect(result.tokens).toBe(500);
    // Resumed runs reuse the carried session id (conversation continuity).
    expect(rec.calls.every((c) => c.sessionId === 'resumed-session-id')).toBe(true);
    // The final checkpoint records the real iteration number, not a fresh count.
    expect(checkpoints[checkpoints.length - 1].iteration).toBe(4);
    expect(checkpoints[checkpoints.length - 1].cumulativeTokens).toBe(500);
  });
});

describe('loop-signal helpers', () => {
  it('readLoopSignal returns null for a missing file and coerces continue defensively', () => {
    const runDir = tmpRunDir();
    expect(readLoopSignal(runDir)).toBeNull();
    fs.writeFileSync(loopSignalPath(runDir), JSON.stringify({ continue: 'yes', reason: 5 }), 'utf-8');
    const sig = readLoopSignal(runDir)!;
    expect(sig.continue).toBe(false); // non-boolean true coerced to false (fail-closed)
    expect(sig.reason).toBeUndefined(); // non-string reason dropped
  });

  it('clearLoopSignal removes the file and is a no-op when already absent', () => {
    const runDir = tmpRunDir();
    fs.writeFileSync(loopSignalPath(runDir), '{"continue":true}', 'utf-8');
    clearLoopSignal(runDir);
    expect(fs.existsSync(loopSignalPath(runDir))).toBe(false);
    expect(() => clearLoopSignal(runDir)).not.toThrow();
  });
});
