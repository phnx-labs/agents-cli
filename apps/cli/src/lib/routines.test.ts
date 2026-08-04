import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { routineOwnerDevice, hasAmbiguousDevicePin, validateJob, validateTrigger, normalizeTriggerEvent, writeJob, readJob, deleteJob, listJobs, jobRunsOnThisDevice, checkJobDeviceEligibility, getJobRunsDir, getRunDir, finalizeRunMeta, writeRunMeta, resolveJobPrompt, getLatestCompletedRun, routineStats, type JobConfig, type RunMeta } from './routines.js';
import { getRoutinesDir, getSystemRoutinesDir, getRunsDir, ensureAgentsDir } from './state.js';
import { ROUTINE_AGENT_IDS } from './runner.js';

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

describe('validateJob — daemon-supported agent (RUSH-2102)', () => {
  it('accepts every agent in the daemon-supported table', () => {
    for (const agent of ROUTINE_AGENT_IDS) {
      const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: agent as never }));
      expect(errors).toEqual([]);
    }
  });

  it('rejects an installable-but-unschedulable agent (opencode) at add time', () => {
    // opencode is a real entry in the AGENTS registry but has no AGENT_COMMANDS
    // template, so the daemon throws "Unsupported agent for daemon jobs" when the
    // job fires. Validation must catch it up front instead.
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'opencode' as never }));
    expect(errors.some((e) => /opencode.*not supported for scheduled routines/.test(e))).toBe(true);
    // the message names the supported set so the user can fix it immediately
    expect(errors.some((e) => e.includes(ROUTINE_AGENT_IDS.join(', ')))).toBe(true);
  });

  it('rejects an unknown agent name', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'foobar' as never }));
    expect(errors.some((e) => /not supported for scheduled routines/.test(e))).toBe(true);
  });

  it('does not flag agent for workflow or command jobs (no agent field)', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', agent: undefined, workflow: 'autodev' }))).toEqual([]);
    expect(validateJob({ name: 'j', schedule: '0 3 * * *', command: 'echo hi' } as Partial<JobConfig>)).toEqual([]);
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
    expect(validateTrigger({
      type: 'github_event',
      event: 'pull_request',
      repo: 'x/y',
      branch: 'main',
      action: 'labeled',
      label: 'ux-approved',
    })).toEqual([]);
  });

  it('accepts a well-formed linear_event trigger', () => {
    expect(validateTrigger({ type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' })).toEqual([]);
  });

  it('accepts stateTo and stateFrom on linear_event triggers', () => {
    expect(validateTrigger({
      type: 'linear_event',
      event: 'Issue',
      action: 'update',
      stateTo: 'Plan',
      stateFrom: 'Triage',
    })).toEqual([]);
  });

  it('rejects non-string stateTo/stateFrom on linear_event triggers', () => {
    expect(validateTrigger({ type: 'linear_event', event: 'Issue', stateTo: 123 as never })).toContain('trigger.stateTo must be a string');
    expect(validateTrigger({ type: 'linear_event', event: 'Issue', stateFrom: 123 as never })).toContain('trigger.stateFrom must be a string');
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

  it('stamps the creator actor at creation and preserves it across an edit (RUSH-2020)', () => {
    ensureAgentsDir();
    const name = '__test-actor-stamp-routine__';
    const name2 = '__test-actor-pinned-routine__';
    try {
      writeJob({ name, schedule: '0 3 * * *', agent: 'claude', prompt: 'p' } as JobConfig);
      const created = readJob(name);
      // A fresh routine gets the current resolver stamped (non-empty id).
      expect(created?.actor).toBeTruthy();
      // An edit re-writes the loaded config (which already carries actor) — the
      // original creator is preserved, not overwritten with the editor.
      writeJob({ ...created!, prompt: 'edited' } as JobConfig);
      const after = readJob(name);
      expect(after?.prompt).toBe('edited');
      expect(after?.actor).toBe(created?.actor);
      // An explicit actor on a new config is kept as-is.
      writeJob({ name: name2, schedule: '0 3 * * *', agent: 'claude', prompt: 'p', actor: 'pinned@example.com' } as JobConfig);
      expect(readJob(name2)?.actor).toBe('pinned@example.com');
    } finally {
      deleteJob(name);
      deleteJob(name2);
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

  // Was 'accepts a job with multiple devices'. A multi-device pin fired the
  // routine once per listed device — duplicate agent runs on every schedule —
  // so it is now a validation error, not an accepted config.
  it('rejects a job with multiple devices', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', devices: ['yosemite-s0', 'mac-mini'] }));
    expect(errors.some((e) => e.includes('runs on exactly one'))).toBe(true);
  });

  it('accepts a job pinned to a single device', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', devices: ['yosemite-s0'] }))).toEqual([]);
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

// A routine pinned to several devices used to fire once PER device: on the live
// fleet `security-sweep` ran at 15:30:02 on one box and 15:30:03 on the other,
// two full agent sessions doing identical work. Ownership is now singular and
// derived from config alone, so every daemon agrees without coordination.
describe('routineOwnerDevice / single-device ownership', () => {
  it('picks one owner deterministically, whatever the list order', () => {
    expect(routineOwnerDevice({ devices: ['yosemite-s1', 'yosemite-s0'] })).toBe('yosemite-s0');
    expect(routineOwnerDevice({ devices: ['yosemite-s0', 'yosemite-s1'] })).toBe('yosemite-s0');
    expect(routineOwnerDevice({ devices: ['Yosemite-S1', 'yosemite-s0.tailnet.ts.net'] })).toBe('yosemite-s0');
  });

  it('returns null for an unrestricted routine, which still fires fleet-wide', () => {
    expect(routineOwnerDevice({})).toBeNull();
    expect(routineOwnerDevice({ devices: [] })).toBeNull();
  });

  it('fires on exactly one of a multi-device pin — never both', () => {
    const pinned = { devices: ['yosemite-s0', 'yosemite-s1'] };
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    expect(jobRunsOnThisDevice(pinned)).toBe(true);
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s1';
    expect(jobRunsOnThisDevice(pinned)).toBe(false);
  });

  it('flags a multi-device pin, ignoring case and domain duplicates', () => {
    expect(hasAmbiguousDevicePin({ devices: ['yosemite-s0', 'yosemite-s1'] })).toBe(true);
    expect(hasAmbiguousDevicePin({ devices: ['yosemite-s0'] })).toBe(false);
    expect(hasAmbiguousDevicePin({ devices: [] })).toBe(false);
    // Same machine spelled two ways is one device, not an ambiguous pin.
    expect(hasAmbiguousDevicePin({ devices: ['Yosemite-S0', 'yosemite-s0.tailnet.ts.net'] })).toBe(false);
  });

  // The daemon's load path never calls validateJob, and ownership treats a
  // non-array `devices` as "no pin" — so without a guard a YAML typo
  // (`devices: yosemite-s0`, a scalar) would silently promote the routine to
  // fleet-wide and fire it on EVERY box. Inert-and-loud beats unrestricted.
  it('refuses to load a routine whose devices is not a list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-malformed-'));
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      process.env.AGENTS_ROUTINES_DIR = path.join(dir, 'routines');
      fs.mkdirSync(path.join(dir, 'routines'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'routines', 'typo.yml'),
        'name: typo\nschedule: "0 3 * * *"\nagent: claude\nprompt: noop\ndevices: yosemite-s0\n',
      );
      expect(readJob('typo')).toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      delete process.env.AGENTS_ROUTINES_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to create a new multi-device routine', () => {
    const errors = validateJob({
      name: 'two-boxes', schedule: '0 3 * * *', agent: 'claude',
      mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'noop',
      devices: ['yosemite-s0', 'yosemite-s1'],
    });
    expect(errors.some((e) => e.includes('runs on exactly one'))).toBe(true);
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
    // A multi-device pin no longer matches every listed device — only its owner
    // (lowest normalized name) fires, so the routine runs once, not once per box.
    expect(jobRunsOnThisDevice({ devices: ['mac-mini', 'yosemite-s0'] })).toBe(false);
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0', 'zion'] })).toBe(true);
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
    // The suggested host is the OWNER (lowest normalized name), not the first
    // entry as written. Suggesting yosemite-s0 here would send the operator to
    // a box that refuses the run for exactly the same reason.
    expect(result!.firstHost).toBe('mac-mini');
    expect(result!.suggestion).toBe("agents routines run backup --host mac-mini");
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
  it('accepts a plain host-placed agent job with a devices pin', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', host: 'gpu-box', devices: ['zion'] }))).toEqual([]);
  });

  it('rejects host placement without a devices pin', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', host: 'gpu-box' }));
    expect(errors.some((e) => e.includes('requires devices'))).toBe(true);
  });

  it('rejects an empty host', () => {
    expect(validateJob(baseJob({ host: '  ', devices: ['zion'] }))).toContainEqual(expect.stringContaining('host must be a non-empty machine name'));
  });

  it('rejects host + workflow (bundle lives on the firing machine)', () => {
    const errors = validateJob(baseJob({ host: 'gpu-box', devices: ['zion'], workflow: 'autodev', agent: undefined }));
    expect(errors.some((e) => e.includes('host placement') && e.includes('workflow'))).toBe(true);
  });

  it('rejects host + loop (driver + signal files live on the firing machine)', () => {
    const errors = validateJob(baseJob({ host: 'gpu-box', devices: ['zion'], loop: { maxIterations: 2 } as JobConfig['loop'] }));
    expect(errors.some((e) => e.includes('host placement') && e.includes('loop'))).toBe(true);
  });

  it('rejects host + command (shell command has no agent to place remotely)', () => {
    const errors = validateJob({ name: 'cmd-on-host', schedule: '0 3 * * *', command: 'echo hi', host: 'gpu-box', devices: ['zion'], mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: '' } as JobConfig);
    expect(errors.some((e) => e.includes('host placement') && e.includes('command'))).toBe(true);
  });

  it('rejects remoteCwd without host/fleet placement', () => {
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

describe('finalizeRunMeta', () => {
  function makeMeta(startedAt: string): RunMeta {
    return {
      jobName: 'j',
      runId: 'r1',
      agent: 'claude',
      pid: null,
      status: 'running',
      startedAt,
      completedAt: null,
      exitCode: null,
    };
  }

  it('sets completedAt, exitCode, status, and computes duration from startedAt', () => {
    const startedAt = new Date(Date.now() - 1234).toISOString();
    const meta = makeMeta(startedAt);
    finalizeRunMeta(meta, 'completed', 0);
    expect(meta.status).toBe('completed');
    expect(meta.exitCode).toBe(0);
    expect(meta.completedAt).not.toBeNull();
    expect(meta.duration).toBeGreaterThanOrEqual(1234);
    expect(meta.errorMessage).toBeUndefined();
  });

  it('records errorMessage on failure when provided', () => {
    const meta = makeMeta(new Date().toISOString());
    finalizeRunMeta(meta, 'failed', 1, { errorMessage: 'spawn failed' });
    expect(meta.status).toBe('failed');
    expect(meta.exitCode).toBe(1);
    expect(meta.errorMessage).toBe('spawn failed');
    expect(meta.duration).toBeGreaterThanOrEqual(0);
  });

  it('uses a provided completedAt override and computes duration from it', () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const completedAt = new Date('2026-01-01T00:00:05.000Z').toISOString();
    const meta = makeMeta(startedAt);
    finalizeRunMeta(meta, 'completed', 0, { completedAt });
    expect(meta.completedAt).toBe(completedAt);
    expect(meta.duration).toBe(5000);
  });

  it('clears a stale errorMessage when finalizing successfully', () => {
    const meta = makeMeta(new Date().toISOString());
    meta.errorMessage = 'stale';
    finalizeRunMeta(meta, 'completed', 0);
    expect(meta.errorMessage).toBeUndefined();
  });

  it('falls back to zero duration when startedAt is unparseable', () => {
    const meta = makeMeta('not-a-date');
    finalizeRunMeta(meta, 'failed', 1);
    expect(meta.duration).toBe(0);
  });
});

describe('getLatestCompletedRun / {last_report} poison-stop', () => {
  // Unique job name under the real runs dir; cleaned up after each test. runIds
  // are chosen so the FAILED run sorts LAST (most recent) — the exact shape that
  // used to poison the next prompt.
  const jobName = `__authtest_poison_${process.pid}`;

  function seedRun(runId: string, status: RunMeta['status'], report: string): void {
    const meta: RunMeta = {
      jobName,
      runId,
      agent: 'claude',
      pid: null,
      status,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: status === 'completed' ? 0 : 1,
      ...(status !== 'completed' ? { errorMessage: 'auth_failed: Failed to authenticate' } : {}),
    };
    writeRunMeta(meta);
    fs.writeFileSync(path.join(getRunDir(jobName, runId), 'report.md'), report, 'utf-8');
  }

  afterEach(() => {
    fs.rmSync(getJobRunsDir(jobName), { recursive: true, force: true });
  });

  it('returns the latest COMPLETED run, skipping a later failed run', () => {
    seedRun('2026-01-01T00-00-00-000Z', 'completed', 'GOOD REPORT');
    seedRun('2026-01-02T00-00-00-000Z', 'failed', 'Not logged in · Please run /login');

    const latest = getLatestCompletedRun(jobName);
    expect(latest?.runId).toBe('2026-01-01T00-00-00-000Z');
  });

  it('returns null when no run has completed', () => {
    seedRun('2026-01-01T00-00-00-000Z', 'failed', 'Failed to authenticate');
    expect(getLatestCompletedRun(jobName)).toBeNull();
  });

  it('{last_report} injects the completed report, never the failed auth text', () => {
    seedRun('2026-01-01T00-00-00-000Z', 'completed', 'GOOD REPORT');
    seedRun('2026-01-02T00-00-00-000Z', 'failed', 'Not logged in · Please run /login');

    const config = {
      name: jobName,
      agent: 'claude',
      schedule: '0 3 * * *',
      prompt: 'Previous: {last_report}',
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;

    const resolved = resolveJobPrompt(config);
    expect(resolved).toContain('GOOD REPORT');
    expect(resolved).not.toContain('Not logged in');
    expect(resolved).not.toContain('/login');
  });

  it('substitutes {{...}} webhook context placeholders when context is passed', () => {
    const config = {
      name: jobName,
      agent: 'claude',
      schedule: '0 3 * * *',
      prompt: 'Issue {{issue.identifier}}: {{issue.title}} (from {{updatedFrom.state.name}})',
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;

    const resolved = resolveJobPrompt(config, {
      source: 'linear',
      event: 'Issue',
      action: 'update',
      issue: { identifier: 'RUSH-42', title: 'Fix it', state: { name: 'Plan' } },
      updatedFrom: { state: { name: 'Triage' } },
    });
    expect(resolved).toBe('Issue RUSH-42: Fix it (from Triage)');
  });
});

describe('routineStats', () => {
  const jobName = `__stats_test_${process.pid}`;

  function seedRun(runId: string, status: RunMeta['status'], duration?: number): void {
    const meta: RunMeta = {
      jobName,
      runId,
      agent: 'claude',
      pid: null,
      status,
      startedAt: new Date().toISOString(),
      completedAt: status === 'missed' ? null : new Date().toISOString(),
      exitCode: status === 'completed' ? 0 : status === 'missed' ? null : 1,
      ...(duration !== undefined ? { duration } : {}),
    };
    writeRunMeta(meta);
  }

  afterEach(() => {
    fs.rmSync(getJobRunsDir(jobName), { recursive: true, force: true });
  });

  it('returns all-zero stats for a job with no runs', () => {
    expect(routineStats(jobName)).toEqual({ count: 0, failed: 0, missed: 0, avgMs: 0, p50: 0, p95: 0 });
  });

  it('counts failed and missed runs separately from count, and folds duration into avg/p50/p95', () => {
    seedRun('r1', 'completed', 10);
    seedRun('r2', 'completed', 20);
    seedRun('r3', 'completed', 30);
    seedRun('r4', 'failed', 40);
    seedRun('r5', 'timeout', 50);
    seedRun('r6', 'missed'); // no duration — a fire that never ran

    const stats = routineStats(jobName);
    expect(stats.count).toBe(6);
    expect(stats.failed).toBe(2); // failed + timeout
    expect(stats.missed).toBe(1);
    // avg of the 5 durations that have one (10+20+30+40+50)/5 = 30
    expect(stats.avgMs).toBe(30);
    expect(stats.p50).toBeGreaterThan(0);
    expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
  });

  it('excludes the missed run (no duration) from the percentile set entirely', () => {
    seedRun('r1', 'completed', 100);
    seedRun('r2', 'missed');

    const stats = routineStats(jobName);
    expect(stats.count).toBe(2);
    expect(stats.missed).toBe(1);
    // Only one real duration sample (100ms) — p50/p95 both collapse to it,
    // not diluted by the missed run's absent duration.
    expect(stats.avgMs).toBe(100);
    expect(stats.p50).toBe(100);
    expect(stats.p95).toBe(100);
  });
});
