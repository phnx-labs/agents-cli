import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { validateJob, validateTrigger, normalizeTriggerEvent, writeJob, readJob, deleteJob, listJobs, jobRunsOnThisDevice, checkJobDeviceEligibility, getJobRunsDir, getRunDir, type JobConfig } from './routines.js';
import { getRoutinesDir, getSystemRoutinesDir, getRunsDir, ensureAgentsDir } from './state.js';

/** Minimal valid schedule-based job. */
function baseJob(partial: Partial<JobConfig> = {}): Partial<JobConfig> {
  return {
    name: 'j',
    agent: 'claude',
    prompt: 'do it',
    ...partial,
  };
}

describe('validateJob — schedule OR trigger', () => {
  it('accepts a schedule-only job (existing cron behavior unchanged)', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *' }))).toEqual([]);
  });

  it('accepts a trigger-only job (no schedule)', () => {
    const errors = validateJob(baseJob({ trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' } }));
    expect(errors).toEqual([]);
  });

  it('accepts a job with both schedule and trigger', () => {
    const errors = validateJob(baseJob({
      schedule: '0 3 * * *',
      trigger: { type: 'github_event', event: 'push' },
    }));
    expect(errors).toEqual([]);
  });

  it('rejects a job with neither schedule nor trigger', () => {
    const errors = validateJob(baseJob({}));
    expect(errors.some((e) => /schedule .* or trigger is required/.test(e))).toBe(true);
  });

  it('still rejects an invalid cron expression', () => {
    const errors = validateJob(baseJob({ schedule: 'not a cron' }));
    expect(errors.some((e) => /invalid cron expression/.test(e))).toBe(true);
  });

  it('surfaces trigger validation errors', () => {
    const errors = validateJob(baseJob({ trigger: { type: 'github_event', event: 'nope' as never } }));
    expect(errors.some((e) => /trigger\.event must be one of/.test(e))).toBe(true);
  });
});

describe('validateJob — resume', () => {
  it('accepts resume with a native-resume agent', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', resume: 'sess-1' }))).toEqual([]);
    expect(validateJob(baseJob({ schedule: '0 3 * * *', agent: 'codex', resume: 'sess-1' }))).toEqual([]);
  });

  it('rejects resume on an agent without native --resume', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'gemini', resume: 'sess-1' }));
    expect(errors.some((e) => /resume is only supported for agents with native --resume/.test(e))).toBe(true);
  });

  it('rejects resume combined with a workflow', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: undefined, workflow: 'autodev', resume: 'sess-1' }));
    expect(errors.some((e) => /resume cannot be combined with workflow/.test(e))).toBe(true);
  });

  it('rejects resume combined with a loop', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', resume: 'sess-1', loop: { maxIterations: 3 } as never }));
    expect(errors.some((e) => /resume cannot be combined with loop/.test(e))).toBe(true);
  });

  it('rejects an empty resume session id', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', resume: '  ' }));
    expect(errors.some((e) => /resume must be a non-empty session id/.test(e))).toBe(true);
  });
});

describe('validateJob — command', () => {
  it('accepts a command-only job (no agent, no prompt)', () => {
    expect(
      validateJob({ name: 'j', schedule: '0 3 * * *', command: 'echo hi' } as Partial<JobConfig>),
    ).toEqual([]);
  });

  it('rejects a job with both agent and command', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', command: 'echo hi' }));
    expect(errors.some((e) => /exactly one of agent, workflow, or command may be set/.test(e))).toBe(true);
  });

  it('rejects a job with both workflow and command', () => {
    const errors = validateJob({ name: 'j', schedule: '0 3 * * *', workflow: 'autodev', command: 'echo hi' } as Partial<JobConfig>);
    expect(errors.some((e) => /exactly one of agent, workflow, or command may be set/.test(e))).toBe(true);
  });

  it('rejects a whitespace-only command string', () => {
    const errors = validateJob({ name: 'j', schedule: '0 3 * * *', command: '   ' } as Partial<JobConfig>);
    expect(errors.some((e) => /command must be a non-empty shell command string/.test(e))).toBe(true);
  });

  it('rejects an empty-string command as a missing target', () => {
    // '' is falsy, so hasCommand is false → the "exactly one required" guard fires.
    const errors = validateJob({ name: 'j', schedule: '0 3 * * *', command: '' } as Partial<JobConfig>);
    expect(errors.some((e) => /exactly one of agent, workflow, or command is required/.test(e))).toBe(true);
  });

  it('rejects a job with none of agent, workflow, or command', () => {
    const errors = validateJob({ name: 'j', schedule: '0 3 * * *' } as Partial<JobConfig>);
    expect(errors.some((e) => /exactly one of agent, workflow, or command is required/.test(e))).toBe(true);
  });
});

describe('validateTrigger', () => {
  it('accepts a well-formed github_event trigger', () => {
    expect(validateTrigger({ type: 'github_event', event: 'pull_request', repo: 'x/y', branch: 'main' })).toEqual([]);
  });

  it('accepts a well-formed linear_event trigger', () => {
    expect(validateTrigger({ type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' })).toEqual([]);
  });

  it('rejects a bad type', () => {
    expect(validateTrigger({ type: 'gitlab', event: 'pull_request' })).toContain("trigger.type must be 'github_event' or 'linear_event'");
  });

  it('rejects an unknown event', () => {
    const errors = validateTrigger({ type: 'github_event', event: 'deploy' });
    expect(errors.some((e) => /trigger\.event must be one of/.test(e))).toBe(true);
  });

  it('rejects a malformed repo', () => {
    const errors = validateTrigger({ type: 'github_event', event: 'push', repo: 'not-a-repo' });
    expect(errors).toContain('trigger.repo must be in owner/name form');
  });
});

describe('default execution mode (RUSH-1595: plan -> auto)', () => {
  it('a routine YAML with no explicit mode defaults to auto', () => {
    ensureAgentsDir();
    const name = '__test-default-mode-rush1595__';
    const file = path.join(getRoutinesDir(), name + '.yml');
    try {
      // Write a raw config that omits `mode` entirely, exercising JOB_DEFAULTS.
      fs.writeFileSync(file, `name: ${name}\nschedule: '0 3 * * *'\nagent: claude\nprompt: do it\n`, 'utf-8');
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.mode).toBe('auto');
    } finally {
      deleteJob(name);
    }
  });

  it('writeJob omits mode when it equals the auto default, but persists a non-default plan', () => {
    ensureAgentsDir();
    const name = '__test-mode-serialize-rush1595__';
    const file = path.join(getRoutinesDir(), name + '.yml');
    const base: JobConfig = {
      name,
      schedule: '0 3 * * *',
      agent: 'claude',
      prompt: 'do it',
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;
    try {
      writeJob({ ...base, mode: 'auto' });
      expect(fs.readFileSync(file, 'utf-8')).not.toMatch(/^mode:/m);

      writeJob({ ...base, mode: 'plan' });
      expect(fs.readFileSync(file, 'utf-8')).toMatch(/^mode:\s*plan/m);
    } finally {
      deleteJob(name);
    }
  });
});

describe('system-layer routines (built-ins from ~/.agents/.system/routines/)', () => {
  const sysDir = getSystemRoutinesDir();

  it('listJobs surfaces a system routine, and a user routine of the same name shadows it', () => {
    ensureAgentsDir();
    const name = '__test-system-routine-union__';
    const sysFile = path.join(sysDir, `${name}.yml`);
    fs.mkdirSync(sysDir, { recursive: true });
    try {
      // A built-in shipped via the system repo — enabled, on a schedule.
      fs.writeFileSync(
        sysFile,
        `name: ${name}\nschedule: '0 9 * * 1'\nagent: claude\nprompt: check for updates\n`,
        'utf-8'
      );

      // Daemon-style call (no cwd) must see the system routine.
      let found = listJobs().find((j) => j.name === name);
      expect(found).toBeDefined();
      expect(found!.enabled).toBe(true);
      expect(readJob(name)?.prompt).toBe('check for updates');

      // A user routine of the same name overrides it (here: disables the built-in).
      writeJob({
        name,
        schedule: '0 9 * * 1',
        agent: 'claude',
        prompt: 'overridden',
        mode: 'auto',
        effort: 'auto',
        timeout: '10m',
        enabled: false,
      } as JobConfig);

      found = listJobs().find((j) => j.name === name);
      expect(found).toBeDefined();
      expect(found!.enabled).toBe(false);          // user copy wins
      expect(found!.prompt).toBe('overridden');
      // Only one entry for the name — user shadows system, no duplicate.
      expect(listJobs().filter((j) => j.name === name).length).toBe(1);
    } finally {
      deleteJob(name);                              // removes the user override
      try { fs.unlinkSync(sysFile); } catch { /* already gone */ }
    }
  });
});

describe('writeJob atomic persistence', () => {
  it('round-trips a job through an atomic write and leaves no temp files', () => {
    ensureAgentsDir();
    const name = '__test-atomic-write-routine__';
    const routinesDir = getRoutinesDir();
    const file = path.join(routinesDir, `${name}.yml`);
    const config: JobConfig = {
      name,
      schedule: '0 3 * * *',
      agent: 'claude',
      prompt: 'round-trip check',
      mode: 'plan',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;
    try {
      writeJob(config);
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.name).toBe(name);
      expect(read!.agent).toBe('claude');
      expect(read!.schedule).toBe('0 3 * * *');
      expect(read!.prompt).toBe('round-trip check');

      const leftovers = fs.readdirSync(routinesDir).filter((f) => f.startsWith(`${name}.yml.tmp-`));
      expect(leftovers).toEqual([]);
    } finally {
      deleteJob(name);
    }
  });
});

describe('normalizeTriggerEvent', () => {
  it('maps canonical names and aliases', () => {
    expect(normalizeTriggerEvent('pull_request')).toBe('pull_request');
    expect(normalizeTriggerEvent('pr')).toBe('pull_request');
    expect(normalizeTriggerEvent('pr_opened')).toBe('pull_request');
    expect(normalizeTriggerEvent('PUSH')).toBe('push');
    expect(normalizeTriggerEvent('comment')).toBe('issue_comment');
    expect(normalizeTriggerEvent('workflow')).toBe('workflow_run');
  });

  it('returns null for unknown events', () => {
    expect(normalizeTriggerEvent('deploy')).toBeNull();
  });
});

describe('validateJob — devices', () => {
  it('accepts a job with a devices allowlist', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', devices: ['yosemite-s0'] }))).toEqual([]);
  });

  it('accepts a job with multiple devices', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', devices: ['yosemite-s0', 'mac-mini'] }))).toEqual([]);
  });

  it('rejects a non-array devices', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', devices: 'yosemite-s0' as never }));
    expect(errors.some((e) => /devices must be an array/.test(e))).toBe(true);
  });

  it('rejects an empty-string entry', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', devices: [''] }));
    expect(errors.some((e) => /each entry in devices/.test(e))).toBe(true);
  });

  it('rejects a stale singular "device" key after v12', () => {
    const config = { ...baseJob({ schedule: '0 3 * * *' }), device: 'yosemite-s0' } as Record<string, unknown>;
    const errors = validateJob(config as Partial<JobConfig>);
    expect(errors.some((e) => /singular "device" key is no longer supported/.test(e) && /devices:/.test(e))).toBe(true);
  });
});

describe('jobRunsOnThisDevice', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
  });

  it('unrestricted jobs run everywhere', () => {
    expect(jobRunsOnThisDevice({})).toBe(true);
    expect(jobRunsOnThisDevice({ devices: undefined })).toBe(true);
    expect(jobRunsOnThisDevice({ devices: [] })).toBe(true);
  });

  it('matches when the allowlist includes this machine', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0'] })).toBe(true);
    expect(jobRunsOnThisDevice({ devices: ['mac-mini', 'yosemite-s0'] })).toBe(true);
  });

  it('normalizes case and domain suffix', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    expect(jobRunsOnThisDevice({ devices: ['Yosemite-S0'] })).toBe(true);
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0.tailnet.ts.net'] })).toBe(true);
  });

  it('rejects when allowlist names other machines', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0'] })).toBe(false);
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0', 'mac-mini'] })).toBe(false);
  });
});

describe('checkJobDeviceEligibility', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
  });

  it('returns null for unrestricted jobs', () => {
    expect(checkJobDeviceEligibility({ name: 'j' })).toBeNull();
    expect(checkJobDeviceEligibility({ name: 'j', devices: [] })).toBeNull();
  });

  it('returns null when this machine is in the allowlist', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    expect(checkJobDeviceEligibility({ name: 'j', devices: ['zion'] })).toBeNull();
  });

  it('returns normalized message, suggestion, and allowed label for foreign jobs', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const result = checkJobDeviceEligibility({ name: 'backup', devices: ['Yosemite-S0.tailnet.ts.net', 'mac-mini'] });
    expect(result).not.toBeNull();
    expect(result!.message).toBe("Job 'backup' can only run on: yosemite-s0, mac-mini");
    expect(result!.allowedLabel).toBe('yosemite-s0, mac-mini');
    expect(result!.firstHost).toBe('yosemite-s0');
    expect(result!.suggestion).toBe("agents routines run backup --host yosemite-s0");
  });
});

describe('readJobFile fails closed on legacy singular device key', () => {
  it('returns null for a YAML file that still contains device:', () => {
    ensureAgentsDir();
    const name = '__test-readjob-device__';
    const file = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      fs.writeFileSync(file, yaml.stringify({
        name, schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 'yosemite-s0',
      }));
      expect(readJob(name)).toBeNull();
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });
});

describe('writeJob extension handling', () => {
  function fullConfig(name: string): JobConfig {
    return {
      name,
      schedule: '0 3 * * *',
      agent: 'claude',
      prompt: 'extension test',
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;
  }

  it('updates an existing .yaml file and does not create a .yml sibling', () => {
    ensureAgentsDir();
    const name = '__test-writejob-yaml__';
    const yamlFile = path.join(getRoutinesDir(), `${name}.yaml`);
    const ymlFile = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      fs.writeFileSync(yamlFile, yaml.stringify({
        name, schedule: '0 4 * * *', agent: 'codex', prompt: 'original',
      }));
      writeJob(fullConfig(name));
      expect(fs.existsSync(yamlFile)).toBe(true);
      expect(fs.existsSync(ymlFile)).toBe(false);
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.agent).toBe('claude');
    } finally {
      if (fs.existsSync(yamlFile)) fs.unlinkSync(yamlFile);
      if (fs.existsSync(ymlFile)) fs.unlinkSync(ymlFile);
    }
  });

  it('creates a new routine as .yml when neither extension exists', () => {
    ensureAgentsDir();
    const name = '__test-writejob-new__';
    const yamlFile = path.join(getRoutinesDir(), `${name}.yaml`);
    const ymlFile = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      writeJob(fullConfig(name));
      expect(fs.existsSync(ymlFile)).toBe(true);
      expect(fs.existsSync(yamlFile)).toBe(false);
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.name).toBe(name);
    } finally {
      if (fs.existsSync(yamlFile)) fs.unlinkSync(yamlFile);
      if (fs.existsSync(ymlFile)) fs.unlinkSync(ymlFile);
    }
  });

  it('throws when both .yml and .yaml files exist for the same name', () => {
    ensureAgentsDir();
    const name = '__test-writejob-both__';
    const ymlFile = path.join(getRoutinesDir(), `${name}.yml`);
    const yamlFile = path.join(getRoutinesDir(), `${name}.yaml`);
    try {
      fs.writeFileSync(ymlFile, yaml.stringify({ name, schedule: '0 3 * * *', agent: 'claude', prompt: 'a' }));
      fs.writeFileSync(yamlFile, yaml.stringify({ name, schedule: '0 4 * * *', agent: 'codex', prompt: 'b' }));
      expect(() => writeJob(fullConfig(name))).toThrow(/both \.yml and \.yaml/);
    } finally {
      if (fs.existsSync(ymlFile)) fs.unlinkSync(ymlFile);
      if (fs.existsSync(yamlFile)) fs.unlinkSync(yamlFile);
    }
  });
});

describe('validateJob — host placement', () => {
  it('accepts a plain host-placed agent job', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', host: 'gpu-box' }))).toEqual([]);
  });

  it('rejects an empty host', () => {
    expect(validateJob(baseJob({ host: '  ' }))).toContainEqual(expect.stringContaining('host must be a non-empty machine name'));
  });

  it('rejects host + workflow (bundle lives on the firing machine)', () => {
    const errors = validateJob(baseJob({ host: 'gpu-box', workflow: 'autodev', agent: undefined }));
    expect(errors).toContainEqual(expect.stringContaining("host: can't be combined with workflow:"));
  });

  it('rejects host + loop (driver + signal files live on the firing machine)', () => {
    const errors = validateJob(baseJob({ host: 'gpu-box', loop: { maxIterations: 2 } as JobConfig['loop'] }));
    expect(errors).toContainEqual(expect.stringContaining("host: can't be combined with loop:"));
  });

  it('rejects host + command (shell command has no agent to place remotely)', () => {
    const errors = validateJob({ name: 'cmd-on-host', schedule: '0 3 * * *', command: 'echo hi', host: 'gpu-box', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: '' } as JobConfig);
    expect(errors).toContainEqual(expect.stringContaining("host: can't be combined with command:"));
  });

  it('rejects remoteCwd without host', () => {
    expect(validateJob(baseJob({ remoteCwd: '~/proj' }))).toContainEqual(expect.stringContaining('remoteCwd only applies'));
  });
});

describe('routine name path containment (C4)', () => {
  const runsDir = path.resolve(getRunsDir());

  it('validateJob rejects a traversal name', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', name: '../../../../etc' })))
      .toContain(
        `invalid name "../../../../etc": must be a single path segment ` +
        `(no '/', '\\\\', or null bytes, and not '.' or '..')`,
      );
  });

  it('validateJob rejects a name with a separator', () => {
    const errs = validateJob(baseJob({ schedule: '0 3 * * *', name: 'a/b' }));
    expect(errs.some(e => e.startsWith('invalid name'))).toBe(true);
  });

  it('validateJob accepts a normal single-segment name', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', name: 'daily-standup' }))).toEqual([]);
  });

  // getRunDir is the run-directory sink reached on the daemon's load/schedule
  // path (runner.ts executeJob/executeJobDetached) — which never calls
  // validateJob — so it must contain the untrusted name itself.
  it('getJobRunsDir / getRunDir contain a benign name under the runs dir', () => {
    const p = getRunDir('daily-standup', 'run-1');
    expect(p).toBe(path.join(runsDir, 'daily-standup', 'run-1'));
    expect(path.resolve(p).startsWith(runsDir + path.sep)).toBe(true);
  });

  it('getRunDir rejects a traversal name so mkdirSync/writes cannot escape the runs dir', () => {
    expect(() => getRunDir('../../../../tmp/evil-routine', 'run-1')).toThrow();
    expect(() => getJobRunsDir('..')).toThrow();
    expect(() => getJobRunsDir('a/b')).toThrow();
  });
});
