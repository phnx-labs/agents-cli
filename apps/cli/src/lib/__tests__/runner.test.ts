import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildJobCommand,
  buildRoutineSpawnEnv,
  dispatchesViaAgentsRun,
  executeJobDetached,
  pinJobBinary,
  resolveRoutineLaunch,
} from '../runner.js';
import { readRunMeta } from '../routines.js';
import { getRunsDir } from '../state.js';
import type { JobConfig } from '../routines.js';
import { getBinaryPath, getVersionDir } from '../versions.js';
import { rotationFailoverChain, type RotateCandidate, type RotateResult } from '../rotate.js';
import { detectRateLimit } from '../exec.js';

function baseJob(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 9 * * 1-5',
    prompt: 'Do the task.',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    agent: 'claude',
    ...overrides,
  } as JobConfig;
}

describe('buildJobCommand', () => {
  it('bare-agent claude plan mode includes --permission-mode plan', () => {
    const argv = buildJobCommand(baseJob({ agent: 'claude', mode: 'plan' }), 'Do the task.');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('plan');
  });

  it('bare-agent claude edit mode includes --permission-mode acceptEdits', () => {
    const argv = buildJobCommand(baseJob({ agent: 'claude', mode: 'edit' }), 'Do the task.');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
  });

  it('workflow plan mode emits exact argv with no --non-interactive and no --permission-mode', () => {
    const argv = buildJobCommand(
      baseJob({ workflow: 'autodev', agent: undefined as unknown as 'claude', mode: 'plan' }),
      '<prompt>',
    );
    expect(argv).toEqual(['agents', 'run', 'autodev', '<prompt>', '--mode', 'plan']);
    expect(argv).not.toContain('--non-interactive');
    expect(argv).not.toContain('--permission-mode');
  });

  it('workflow edit mode emits exact argv with --mode edit', () => {
    const argv = buildJobCommand(
      baseJob({ workflow: 'autodev', agent: undefined as unknown as 'claude', mode: 'edit' }),
      '<prompt>',
    );
    expect(argv).toEqual(['agents', 'run', 'autodev', '<prompt>', '--mode', 'edit']);
    expect(argv).not.toContain('--non-interactive');
  });

  it('resume emits `agents run <agent> --resume <id>` and reopens the session (not a fresh template)', () => {
    const argv = buildJobCommand(
      baseJob({ agent: 'claude', mode: 'skip', resume: 'sess-abc123' }),
      '<wake prompt>',
    );
    expect(argv).toEqual(['agents', 'run', 'claude', '--resume', 'sess-abc123', '<wake prompt>', '--mode', 'skip']);
    // Resume takes precedence over the fresh-agent template — none of its flags leak in.
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  // Regression: kimi daemon jobs run headless via `--prompt`, which cannot be
  // combined with --plan/--auto/--yolo (kimi aborts "Cannot combine --prompt
  // with --X"). Write-modes must omit the flag; plan must fail closed.
  it('kimi skip mode omits --yolo (incompatible with headless --prompt)', () => {
    const argv = buildJobCommand(baseJob({ agent: 'kimi', mode: 'skip' }), 'Do the task.');
    expect(argv).toContain('--prompt');
    expect(argv).not.toContain('--yolo');
  });

  it('kimi auto mode omits --auto', () => {
    const argv = buildJobCommand(baseJob({ agent: 'kimi', mode: 'auto' }), 'Do the task.');
    expect(argv).not.toContain('--auto');
  });

  it('kimi plan mode downgrades to auto — no throw, no --plan (RUSH-1810)', () => {
    // Routines run headless; kimi's headlessPlan:false makes a plan request degrade
    // to auto (kimi -p auto-runs, carrying no startup-mode flag). Must not throw.
    let argv: string[] = [];
    expect(() => {
      argv = buildJobCommand(baseJob({ agent: 'kimi', mode: 'plan' }), 'Do the task.');
    }).not.toThrow();
    expect(argv).toContain('--prompt');
    expect(argv).not.toContain('--plan');
    expect(argv).not.toContain('--auto');
  });
});

describe('dispatchesViaAgentsRun — pin exclusion for `agents run` commands', () => {
  // Regression: resume commands start with 'agents' (the dispatcher), so binary-pinning
  // them rewrites cmd[0] -> the agent binary and yields a broken `<binary> run …`.
  // executeJob/executeJobDetached must skip pinning for these, exactly like workflow jobs.
  it('is true for resume and workflow jobs, false for a plain agent job', () => {
    expect(dispatchesViaAgentsRun(baseJob({ agent: 'claude', resume: 'sess-1' }))).toBe(true);
    expect(dispatchesViaAgentsRun(baseJob({ workflow: 'autodev', agent: undefined as unknown as 'claude' }))).toBe(true);
    expect(dispatchesViaAgentsRun(baseJob({ agent: 'claude' }))).toBe(false);
  });

  it('pinJobBinary would corrupt a resume command — proving why it must be excluded', () => {
    // A resume command: cmd[0] is the 'agents' dispatcher, not the agent binary.
    const resumeCmd = buildJobCommand(baseJob({ agent: 'claude', mode: 'skip', resume: 'sess-1' }), '<p>');
    expect(resumeCmd[0]).toBe('agents');
    // If pinJobBinary DID run on it and the version were installed, it would clobber
    // cmd[0] to the binary → `<binary> run claude …`. The guard is what prevents this.
    expect(dispatchesViaAgentsRun({ resume: 'sess-1' })).toBe(true);
  });
});

describe('executeJobDetached — spawn error handling', () => {
  const cleanupJobDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupJobDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('marks run failed in meta.json on spawn error without throwing', async () => {
    // Seed an "installed" version whose binary path is a directory — pinJobBinary
    // rewrites to that absolute path, and spawn then fails with EISDIR/ENOENT so
    // the error handler rewrites meta. Guaranteed even when a real `codex` is on PATH.
    const version = '0.0.1-enoent-test';
    const versionDir = getVersionDir('codex', version);
    const binPath = getBinaryPath('codex', version);
    fs.mkdirSync(binPath, { recursive: true }); // directory where a file should be

    const config: JobConfig = {
      name: '__runner-test-enoent__',
      schedule: '0 0 * * *',
      agent: 'codex',
      version,
      mode: 'plan',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
      prompt: 'test prompt',
      sandbox: false,
    };

    cleanupJobDirs.push(path.join(getRunsDir(), config.name));

    try {
      const meta = await executeJobDetached(config);
      expect(meta.status).toBe('running');

      // The spawn error event is async and rewrites meta.json off the event
      // loop. A fixed sleep flakes on slow Windows CI (the event lands after
      // the window); poll for the terminal state up to 10s instead.
      let updated = readRunMeta(config.name, meta.runId);
      const deadline = Date.now() + 10_000;
      while ((updated?.status ?? 'running') === 'running' && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 50));
        updated = readRunMeta(config.name, meta.runId);
      }

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('failed');
      expect(updated!.exitCode).toBe(1);
      expect(updated!.completedAt).not.toBeNull();
    } finally {
      try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('pinJobBinary (RUSH-1016 — absolute path, bypass bare shim)', () => {
  const version = '99.99.99-test';

  it('rewrites cmd[0] to the absolute binary when the version is installed', () => {
    const versionDir = getVersionDir('claude', version);
    const binaryPath = getBinaryPath('claude', version);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    try {
      const pinned = pinJobBinary(['claude', '-p', 'hi'], 'claude', version);
      expect(pinned[0]).toBe(binaryPath);
      expect(pinned.slice(1)).toEqual(['-p', 'hi']);
    } finally {
      try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('leaves cmd unchanged when version is missing or binary absent', () => {
    const cmd = ['claude', '-p', 'hi'];
    expect(pinJobBinary(cmd, 'claude', '0.0.0-missing')).toEqual(cmd);
    expect(pinJobBinary(cmd, 'claude', undefined)).toEqual(cmd);
  });
});

describe('resolveRoutineLaunch (RUSH-1016 — pin + failover chain)', () => {
  it('honors an explicit version pin and does not arm rotation failover', async () => {
    const plan = await resolveRoutineLaunch(
      baseJob({ name: 'pinned-job', version: '2.1.0', agent: 'claude' }),
    );
    expect(plan.pinned).toBe(true);
    expect(plan.rotation).toBeNull();
    expect(plan.chain).toEqual([{ agent: 'claude', version: '2.1.0' }]);
  });

  it('leaves workflow jobs without a version chain', async () => {
    const plan = await resolveRoutineLaunch(
      baseJob({
        name: 'wf-job',
        workflow: 'autodev',
        agent: undefined as unknown as 'claude',
      }),
    );
    expect(plan.chain).toEqual([]);
    expect(plan.pinned).toBe(false);
  });
});

describe('buildRoutineSpawnEnv', () => {
  it('pins CLAUDE_CONFIG_DIR for a versioned claude launch and preserves TZ', () => {
    const env = buildRoutineSpawnEnv(
      { HOME: '/tmp/overlay', PATH: '/usr/bin' },
      'claude',
      '2.1.0',
      'America/Los_Angeles',
    );
    expect(env.TZ).toBe('America/Los_Angeles');
    expect(env.CLAUDE_CONFIG_DIR).toContain(path.join('claude', '2.1.0'));
    expect(env.CLAUDE_CONFIG_DIR).toContain('.claude');
    expect(env.HOME).toBe('/tmp/overlay');
  });
});

describe('credit/rate-limit detect + failover chain composition (RUSH-1016)', () => {
  function candidate(over: Partial<RotateCandidate> & { version: string }): RotateCandidate {
    return {
      agent: 'claude',
      accountKey: `claude:account=${over.version}`,
      accountLabel: `${over.version}@example.com`,
      email: `${over.version}@example.com`,
      usageKey: `claude:org=${over.version}`,
      usageStatus: 'available',
      usageSnapshot: null,
      usageError: null,
      plan: 'Max',
      signedIn: true,
      lastActive: null,
      ...over,
    };
  }

  it('detectRateLimit matches credit/usage phrasing used in failover diagnostics', () => {
    expect(detectRateLimit('You have hit your usage limit')).toBe(true);
    expect(detectRateLimit('rate limit exceeded')).toBe(true);
    expect(detectRateLimit('quota exceeded for this org')).toBe(true);
    expect(detectRateLimit('ENOENT: no such file')).toBe(false);
  });

  it('rotationFailoverChain skips the primary and preserves healthy order', () => {
    const healthy = [
      candidate({ version: '2.1.143' }),
      candidate({ version: '2.1.142' }),
      candidate({ version: '2.1.141' }),
    ];
    const rotation: RotateResult = {
      picked: healthy[0],
      healthy,
      excluded: [candidate({ version: '2.1.140', usageStatus: 'out_of_credits' })],
    };
    const chain = rotationFailoverChain(rotation, '2.1.143');
    expect(chain.map((e) => e.version)).toEqual(['2.1.142', '2.1.141']);
    // Primary + failover is what resolveRoutineLaunch returns as chain.
    const full = [{ agent: 'claude' as const, version: '2.1.143' }, ...chain];
    expect(full[0].version).toBe('2.1.143');
    expect(full).toHaveLength(3);
  });
});
