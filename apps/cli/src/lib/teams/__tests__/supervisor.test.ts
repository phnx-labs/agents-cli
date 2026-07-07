import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  type AgentType,
} from '../agents.js';
import { runSupervisor } from '../supervisor.js';

let tmpBase: string;
let mgr: AgentManager;

beforeEach(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-test-'));
  mgr = new AgentManager(50, tmpBase);
  await mgr.listAll();
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/**
 * Plant a fully-formed teammate without invoking the CLI. Used to set up
 * DAG shapes we then drive the supervisor through.
 */
async function plantAgent(
  taskName: string,
  overrides: Partial<{
    agentId: string;
    name: string | null;
    after: string[];
    status: AgentStatus;
    taskType: 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs' | null;
  }> = {}
): Promise<AgentProcess> {
  const agent = new AgentProcess(
    overrides.agentId ?? `agent-${Math.random().toString(36).slice(2, 10)}`,
    taskName,
    'claude' as AgentType,
    'prompt',
    null,
    'edit',
    overrides.status === AgentStatus.RUNNING ? process.pid : null,
    overrides.status ?? AgentStatus.COMPLETED,
    new Date(Date.now() - 10), new Date(),
    tmpBase,
    null, null, null, null, null, null, null,
    overrides.name ?? null,
    overrides.after ?? [],
    'medium', null, null,
    overrides.taskType ?? null
  );
  await agent.saveMeta();
  mgr.registerAgent(agent);
  return agent;
}

describe('runSupervisor', () => {
  it('drains immediately when the DAG is empty', async () => {
    const events: number[] = [];
    const result = await runSupervisor(mgr, {
      team: 'empty',
      intervalMs: 50,
      onWave: (s) => { events.push(s.launched.length); },
    });
    expect(result.stoppedBy).toBe('drained');
    expect(result.waves).toBe(1);
    expect(events).toEqual([0]);
  });

  it('drains when all teammates are already completed', async () => {
    await plantAgent('t1', { name: 'impl-a', status: AgentStatus.COMPLETED, taskType: 'implement' });
    await plantAgent('t1', { name: 'test-a', status: AgentStatus.COMPLETED, taskType: 'test', after: ['impl-a'] });

    const waves: Array<{ pending: number; running: number; completed: number }> = [];
    const result = await runSupervisor(mgr, {
      team: 't1',
      intervalMs: 50,
      onWave: (s) => { waves.push({ pending: s.pending, running: s.running, completed: s.completed }); },
    });
    expect(result.stoppedBy).toBe('drained');
    expect(waves[waves.length - 1]).toEqual({ pending: 0, running: 0, completed: 2 });
  });

  it('picks up a teammate added mid-flight', async () => {
    // Simulate a worker filing a new task during its run. `after` points at
    // a never-completing dep so startReady can't auto-launch it — the
    // teammate stays PENDING for observation, then we flip it to completed
    // on wave 3 to drain.
    let added = false;
    let wavesSeen = 0;
    const waveSnaps: Array<{ pending: number; running: number; completed: number }> = [];

    const result = await runSupervisor(mgr, {
      team: 'dyn',
      intervalMs: 30,
      maxWaves: 15,
      onWave: async (s) => {
        wavesSeen++;
        waveSnaps.push({ pending: s.pending, running: s.running, completed: s.completed });
        if (!added) {
          added = true;
          await plantAgent('dyn', {
            name: 'late-pending',
            status: AgentStatus.PENDING,
            after: ['__never_done__'],
            taskType: 'implement',
          });
          return;
        }
        if (wavesSeen >= 3) {
          // Release the teammate: mark completed so the DAG can drain.
          const all = await mgr.listByTask('dyn');
          for (const a of all) {
            if (a.name === 'late-pending' && a.status !== AgentStatus.COMPLETED) {
              a.status = AgentStatus.COMPLETED;
              a.completedAt = new Date();
              await a.saveMeta();
            }
          }
        }
      },
    });

    expect(result.stoppedBy).toBe('drained');
    expect(result.waves).toBeGreaterThanOrEqual(3);
    // Key invariant: at least one wave observed >=1 pending (the late add
    // was noticed) before drain.
    expect(waveSnaps.some((s) => s.pending >= 1)).toBe(true);
  });

  it('stops when onWave returns false', async () => {
    await plantAgent('t1', { name: 'impl-a', status: AgentStatus.RUNNING, taskType: 'implement' });
    let waveCount = 0;
    const result = await runSupervisor(mgr, {
      team: 't1',
      intervalMs: 50,
      maxWaves: 100,
      onWave: () => {
        waveCount++;
        return waveCount >= 3 ? false : true;
      },
    });
    expect(result.stoppedBy).toBe('callback');
    expect(result.waves).toBe(3);
  });

  it('rescans disk so teammates created by a sibling process get picked up', async () => {
    // Simulate a sibling process writing a meta.json directly to the
    // agents dir. Without rescan, the supervisor would never see it
    // because its in-memory cache wouldn't update.
    let waveCount = 0;
    // Pre-seed a running teammate so the DAG starts live and the
    // supervisor runs multiple waves.
    await plantAgent('cross-proc', {
      name: 'seed',
      status: AgentStatus.RUNNING,
      taskType: 'implement',
    });
    const seenNames: Set<string> = new Set();
    const result = await runSupervisor(mgr, {
      team: 'cross-proc',
      intervalMs: 20,
      maxWaves: 10,
      onWave: async (s) => {
        waveCount++;
        for (const a of await mgr.listByTask('cross-proc')) {
          if (a.name) seenNames.add(a.name);
        }
        if (waveCount === 1) {
          // Sibling-process simulation: write meta.json directly.
          const newId = 'cross-proc-alien';
          const dir = path.join(tmpBase, newId);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
            agent_id: newId,
            task_name: 'cross-proc',
            agent_type: 'claude',
            prompt: 'p', cwd: null, workspace_dir: null,
            mode: 'edit', pid: null,
            status: 'completed',
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            name: 'alien', after: [], task_type: 'implement',
          }));
        }
        if (waveCount === 2) {
          // Release the seed so the DAG can drain.
          const all = await mgr.listByTask('cross-proc');
          for (const a of all) {
            if (a.name === 'seed') {
              a.status = AgentStatus.COMPLETED;
              a.completedAt = new Date();
              await a.saveMeta();
            }
          }
        }
      },
    });
    expect(result.stoppedBy).toBe('drained');
    expect(seenNames.has('alien')).toBe(true);
    expect(seenNames.has('seed')).toBe(true);
  });

  it('stops at --max-waves if the DAG never drains', async () => {
    await plantAgent('t1', { name: 'running', status: AgentStatus.RUNNING, taskType: 'implement' });
    const result = await runSupervisor(mgr, {
      team: 't1',
      intervalMs: 30,
      maxWaves: 4,
      onWave: () => {},
    });
    expect(result.stoppedBy).toBe('max-waves');
    expect(result.waves).toBe(4);
  });
});
