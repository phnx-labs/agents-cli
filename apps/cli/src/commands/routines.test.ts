/**
 * End-to-end CLI subprocess tests for `agents routines` device-affinity commands.
 *
 * Every test spawns the real CLI (`node --import tsx src/index.ts routines ...`)
 * against an isolated mkdtemp HOME — no live ~/.agents state, no mocks, no
 * imported writeJob/readJob. Modeled on `routines-webhook.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { buildRunsJson, groupRoutineJobsByProject } from './routines.js';
import type { JobConfig } from '../lib/routines.js';
import type { RunMeta } from '../lib/routines.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
// `--import` takes a module specifier, not a path: a bare Windows path like
// `D:\a\...\tsx\dist\loader.mjs` is parsed as a URL with protocol 'd:' and the
// child dies with ERR_UNSUPPORTED_ESM_URL_SCHEME before running the CLI. Same
// pattern as sessions.test.ts:21.
const TSX_IMPORT = pathToFileURL(require.resolve('tsx')).href;
const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'src', 'index.ts');

// win32: subprocess CLI + process-group signals / path spawn assumptions (RUSH-2215).
const describeRoutines = process.platform === 'win32' ? describe.skip : describe;


/** Provision an isolated HOME with agents.yaml, .system/.git, and optional routines + device registry. */
function makeHome(opts: {
  jobs?: Record<string, unknown>[];
  projectJobs?: Record<string, unknown>[];
  registry?: Record<string, unknown>;
  deviceRoutines?: Record<string, string[]>;
} = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-routines-test-'));
  const agentsDir = path.join(home, '.agents');
  const routinesDir = path.join(agentsDir, 'routines');
  const projectDir = path.join(home, 'project');
  const projectRoutinesDir = path.join(projectDir, '.agents', 'routines');
  fs.mkdirSync(routinesDir, { recursive: true });
  fs.mkdirSync(projectRoutinesDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'agents.yaml'), 'agents: {}\n');
  fs.mkdirSync(path.join(agentsDir, '.system', '.git'), { recursive: true });

  for (const job of opts.jobs ?? []) {
    fs.writeFileSync(
      path.join(routinesDir, `${job.name}.yml`),
      yaml.stringify(job),
    );
  }

  for (const job of opts.projectJobs ?? []) {
    fs.writeFileSync(
      path.join(projectRoutinesDir, `${job.name}.yml`),
      yaml.stringify(job),
    );
  }

  if (opts.registry) {
    const devicesDir = path.join(agentsDir, '.history', 'devices');
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(path.join(devicesDir, 'registry.json'), JSON.stringify(opts.registry));
  }

  for (const [device, routines] of Object.entries(opts.deviceRoutines ?? {})) {
    writeDeviceRoutines(home, device, routines);
  }

  return home;
}

/** Run `agents routines <args>` against an isolated HOME. */
function run(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd: string = REPO_ROOT,
): ReturnType<typeof spawnSync> {
  return spawnSync('node', ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'routines', ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // Point the device registry at this test's home (RUSH-2042): getDevicesDir()
      // reads AGENTS_DEVICES_DIR, and the parent vitest fork exports its own via
      // setup.ts — override it so the child reads the registry makeHome() wrote.
      AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
      AGENTS_SKIP_MIGRATION: '1',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function readRoutineYaml(home: string, name: string): Record<string, unknown> | null {
  const p = path.join(home, '.agents', 'routines', `${name}.yml`);
  if (!fs.existsSync(p)) return null;
  return yaml.parse(fs.readFileSync(p, 'utf-8'));
}

describeRoutines('routines add help', () => {
  it('lists exactly the agents backed by the daemon command table', () => {
    const home = makeHome();
    try {
      const result = run(home, ['add', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /Which agent runs this routine: claude, codex, gemini,\s+cursor, kimi, droid/,
      );
      const agentLine = result.stdout.split('\n').find((line) => line.includes('--agent')) ?? '';
      expect(agentLine).not.toContain('antigravity');
      expect(agentLine).not.toContain('opencode');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

function writeRunMeta(home: string, jobName: string, runId: string, meta: Record<string, unknown>): void {
  const runDir = path.join(home, '.agents', '.history', 'runs', jobName, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta));
}

function daemonPidPath(home: string): string {
  return path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
}

function readDaemonPid(home: string): number | null {
  const pidPath = daemonPidPath(home);
  if (!fs.existsSync(pidPath)) return null;
  const raw = fs.readFileSync(pidPath, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

/** Start the real scheduler foreground process against an isolated HOME. */
function startIsolatedDaemon(home: string): { child: ReturnType<typeof spawn>; pidPromise: Promise<number | null> } {
  const child = spawn('node', ['--import', 'tsx', 'src/index.ts', '__daemon-run'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '1',
    },
    detached: true,
    stdio: 'ignore',
  });

  const pidPromise = new Promise<number | null>((resolve) => {
    const deadline = Date.now() + 15_000;
    const interval = setInterval(() => {
      const pid = readDaemonPid(home);
      if (pid) {
        clearInterval(interval);
        resolve(pid);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(interval);
        resolve(null);
      }
    }, 50);
  });

  return { child, pidPromise };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Terminate a daemon process started by startIsolatedDaemon and wait for it to exit. */
async function stopIsolatedDaemon(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;

  const closePromise = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.on('close', () => resolve());
  });

  if (child.exitCode !== null || child.signalCode !== null) return;

  const signalProcessGroup = process.platform !== 'win32';
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (signalProcessGroup) {
        process.kill(-child.pid!, sig);
      } else {
        child.kill(sig);
      }
    } catch {
      // already gone
    }
  };

  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 3_000);
  await closePromise;
  clearTimeout(timer);
}

const baseJob = {
  name: 'test-job',
  schedule: '0 3 * * *',
  agent: 'claude',
  prompt: 'noop',
  // Legacy fixture state: tests that specifically cover the new manifest model
  // materialize a device document below.
  enabled: true,
};

const registry = {
  'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
  'mac-mini': { name: 'mac-mini', platform: 'macos' },
  'zion': { name: 'zion', platform: 'macos' },
};

function readDeviceRoutines(home: string, device: string): string[] {
  const file = path.join(home, '.agents', 'devices', device, 'agents.yaml');
  if (!fs.existsSync(file)) return [];
  return yaml.parse(fs.readFileSync(file, 'utf-8')).routines ?? [];
}

function writeDeviceRoutines(home: string, device: string, routines: string[]): void {
  const dir = path.join(home, '.agents', 'devices', device);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.yaml'), yaml.stringify({ routines }));
}

describeRoutines('routines devices --set persists', () => {
  it('writes activation to the target device manifest without changing definition metadata', () => {
    const home = makeHome({ jobs: [baseJob], registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'yosemite-s0'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status, res.stderr + res.stdout).toBe(0);

      const doc = readRoutineYaml(home, 'test-job');
      expect(doc).not.toBeNull();
      expect(doc!.devices).toBeUndefined();
      expect(readDeviceRoutines(home, 'yosemite-s0')).toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set on .yaml-only routine', () => {
  it('leaves the .yaml definition untouched and list --json reports enabled devices+runsHere', () => {
    const home = makeHome({ registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const yamlPath = path.join(home, '.agents', 'routines', 'yaml-only.yaml');
      fs.writeFileSync(
        yamlPath,
        yaml.stringify({ name: 'yaml-only', schedule: '0 3 * * *', agent: 'claude', prompt: 'noop' }),
      );

      const setRes = run(home, ['devices', 'yaml-only', '--set', 'yosemite-s0'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(setRes.status).toBe(0);

      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'yaml-only.yml'))).toBe(false);
      const doc = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
      expect(doc.devices).toBeUndefined();

      const listRes = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(listRes.status).toBe(0);
      const parsed = JSON.parse(listRes.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'yaml-only');
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual(['yosemite-s0']);
      expect(entry.runsHere).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set normalizes mixed case and FQDN duplicates', () => {
  it('persists one normalized entry per device', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'Yosemite-S0,yosemite-s0.tailnet.ts.net'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const doc = readRoutineYaml(home, 'test-job');
      expect(doc).not.toBeNull();
      expect(doc!.devices).toEqual(['yosemite-s0']);
      expect(readDeviceRoutines(home, 'yosemite-s0')).toEqual(['test-job']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --clear removes activation', () => {
  it('removes the routine from this device manifest without rewriting YAML', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      writeDeviceRoutines(home, 'yosemite-s0', ['test-job']);
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      const res = run(home, ['devices', 'test-job', '--clear'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const raw = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(raw).toBe(before);
      expect(readDeviceRoutines(home, 'yosemite-s0')).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set unknown is nonzero/no mutation', () => {
  it('rejects unknown device names and does not mutate the YAML', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry, deviceRoutines: { 'yosemite-s0': ['test-job'] } });
    try {
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');

      const res = run(home, ['devices', 'test-job', '--set', 'nonexistent-box']);
      expect(res.status).not.toBe(0);

      const after = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// #2118: --set fans out pause/resume to every registered device. An offline
// peer that is NOT in the new set must be a warning, not a hard fail — the
// pin on the reachable target already succeeded.
describeRoutines('routines devices --set skips unreachable non-targets (#2118)', () => {
  it('enables on the local target and warns about an offline peer that cannot be paused', () => {
    const offlinePeer = {
      name: 'offline-box',
      platform: 'macos',
      // No dnsName/ip: resolveHost fails immediately (no SSH hang) the same way
      // a sleeping Tailscale host does for applyDevices' remote pause.
      address: { via: 'manual' },
      auth: { method: 'key' },
    };
    const home = makeHome({
      jobs: [baseJob],
      registry: {
        'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
        'offline-box': offlinePeer,
      },
    });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'yosemite-s0'], {
        AGENTS_SYNC_MACHINE_ID: 'yosemite-s0',
      });
      expect(res.status, res.stderr + res.stdout).toBe(0);
      expect(res.stdout + res.stderr).toMatch(/Skipped pause of 'test-job' on offline-box/i);
      expect(res.stdout + res.stderr).toMatch(/enabled on: yosemite-s0/i);
      expect(res.stdout + res.stderr).toMatch(/offline device.*skipped/i);
      expect(readDeviceRoutines(home, 'yosemite-s0')).toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits non-zero when a selected target device cannot be reached', () => {
    const offlinePeer = {
      name: 'offline-box',
      platform: 'macos',
      address: { via: 'manual' },
      auth: { method: 'key' },
    };
    const home = makeHome({
      jobs: [baseJob],
      registry: {
        'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
        'offline-box': offlinePeer,
      },
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'offline-box'], {
        AGENTS_SYNC_MACHINE_ID: 'yosemite-s0',
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toMatch(/Could not enable 'test-job' on: offline-box/i);
      // Local pause (removing the routine from this device) still applied before
      // the remote target failed — pin must not claim full success.
      expect(readDeviceRoutines(home, 'yosemite-s0')).not.toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --clear skips unreachable peers (#2118)', () => {
  it('clears the local pin and reports skipped offline peers instead of aborting', () => {
    const offlinePeer = {
      name: 'offline-box',
      platform: 'macos',
      address: { via: 'manual' },
      auth: { method: 'key' },
    };
    const home = makeHome({
      jobs: [{ ...baseJob, devices: ['yosemite-s0'] }],
      registry: {
        'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
        'offline-box': offlinePeer,
      },
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      const res = run(home, ['devices', 'test-job', '--clear'], {
        AGENTS_SYNC_MACHINE_ID: 'yosemite-s0',
      });
      expect(res.status, res.stderr + res.stdout).toBe(0);
      expect(res.stdout + res.stderr).toMatch(/Skipped pause of 'test-job' on offline-box/i);
      expect(res.stdout + res.stderr).toMatch(/disabled on every registered device/i);
      expect(readDeviceRoutines(home, 'yosemite-s0')).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --devices unknown is nonzero/no write', () => {
  it('rejects unknown devices and does not create the routine file', () => {
    const home = makeHome({ registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const res = run(home, [
        'add', 'new-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--devices', 'nonexistent-box',
      ]);
      expect(res.status).not.toBe(0);
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'new-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --agent unsupported by the local daemon (RUSH-2102)', () => {
  it('rejects a real agent the daemon cannot fire, at add time, and writes no routine file', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'bad-agent-job',
        '--schedule', '0 3 * * *',
        '--agent', 'opencode',
        '--prompt', 'hi',
      ]);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("agent 'opencode' is not supported by the local routine daemon");
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'bad-agent-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('still accepts a daemon-supported agent for a local routine', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'good-agent-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
      ]);
      expect(res.status).toBe(0);
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'good-agent-job.yml'))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --on aliases', () => {
  it('accepts the pr GitHub alias and writes the canonical trigger event', async () => {
    const home = makeHome({ registry });
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      const res = run(home, [
        'add', 'pr-job',
        '--on', 'pr',
        '--repo', 'phnx-labs/agents-cli',
        '--action', 'labeled',
        '--label', 'ux-approved',
        '--agent', 'claude',
        '--prompt', 'handle pull request',
      ]);
      expect(res.status).toBe(0);

      const doc = readRoutineYaml(home, 'pr-job');
      expect(doc).not.toBeNull();
      expect(doc!.trigger).toEqual({
        type: 'github_event',
        event: 'pull_request',
        repo: 'phnx-labs/agents-cli',
        action: 'labeled',
        label: 'ux-approved',
      });
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (typeof pid === 'number') expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --json', () => {
  it('emits only the created routine id and status on stdout', async () => {
    const home = makeHome({ registry });
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      const res = run(home, [
        'add', 'json-job',
        '--schedule', '0 3 * * *',
        '--command', 'printf ok',
        '--json',
      ]);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed).toMatchObject({
        jobId: 'json-job',
        name: 'json-job',
        status: 'added',
        enabled: true,
        schedule: '0 3 * * *',
      });
      expect(parsed.trigger).toBeNull();
      expect(res.stdout.trim().split('\n')).toHaveLength(1);
      expect(res.stderr).not.toContain('Scheduler reloaded');

      const doc = readRoutineYaml(home, 'json-job');
      expect(doc).not.toBeNull();
      expect(doc!.command).toBe('printf ok');
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (typeof pid === 'number') expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add one-shot-looking --schedule', () => {
  it('warns, persists runOnce, and keeps JSON stdout parseable', async () => {
    const home = makeHome({ registry });
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      const res = run(home, [
        'add', 'date-cron',
        '--schedule', '0 14 31 12 *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--json',
      ]);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toMatchObject({
        jobId: 'date-cron',
        schedule: '0 14 31 12 *',
      });
      expect(res.stderr).toContain('treating it as one-shot');

      const doc = readRoutineYaml(home, 'date-cron');
      expect(doc).not.toBeNull();
      expect(doc!.runOnce).toBe(true);
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (typeof pid === 'number') expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list --json has devices+runsHere, no device', () => {
  it('includes devices array and runsHere, excludes singular device key', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      const res = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual(['yosemite-s0']);
      expect(typeof entry.runsHere).toBe('boolean');
      expect(entry.runsHere).toBe(true);
      expect('device' in entry).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('honors user-layer devices when a repo-bound project routine shadows the same name', () => {
    const userJob = {
      ...baseJob,
      repo: 'phnx-labs/agents-cli',
      devices: ['zion'],
      prompt: 'user noop',
    };
    const projectJob = {
      ...baseJob,
      repo: 'phnx-labs/agents-cli',
      prompt: 'project noop',
    };
    const home = makeHome({
      jobs: [userJob],
      projectJobs: [projectJob],
      registry,
      deviceRoutines: { zion: ['test-job'], 'yosemite-s0': [] },
    });
    const projectDir = path.join(home, 'project');
    try {
      const remoteRes = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' }, projectDir);
      expect(remoteRes.status).toBe(0);
      const remoteParsed = JSON.parse(remoteRes.stdout.trim());
      const remoteEntry = remoteParsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(remoteEntry).toBeDefined();
      expect(remoteEntry.repo).toBe('phnx-labs/agents-cli');
      expect(remoteEntry.devices).toEqual(['zion']);
      expect(remoteEntry.runsHere).toBe(false);
      expect(remoteEntry.nextRun).toBeNull();

      const localRes = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'zion' }, projectDir);
      expect(localRes.status).toBe(0);
      const localParsed = JSON.parse(localRes.stdout.trim());
      const localEntry = localParsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(localEntry).toBeDefined();
      expect(localEntry.devices).toEqual(['zion']);
      expect(localEntry.runsHere).toBe(true);
      expect(localEntry.nextRun).not.toBeNull();

      const viewRes = run(home, ['view', 'test-job'], { AGENTS_SYNC_MACHINE_ID: 'zion' }, projectDir);
      expect(viewRes.status).toBe(0);
      // Strip ANSI (FORCE_COLOR / chalk.bold on the Job: header) before YAML parse.
      const viewPlain = viewRes.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const viewDoc = yaml.parse(viewPlain.replace(/^Job: test-job\s*/m, ''));
      expect(viewDoc.prompt).toBe('project noop');
      expect(viewDoc.devices).toEqual(['zion']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('shows empty devices array and runsHere=true when unrestricted', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['list', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual([]);
      expect(entry.runsHere).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('includes latest run exitCode and failureReason', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      writeRunMeta(home, 'test-job', '2026-07-21T10-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'failed',
        startedAt: '2026-07-21T10:00:00.000Z',
        completedAt: '2026-07-21T10:00:05.000Z',
        exitCode: 2,
        errorMessage: 'command exited with code 2',
      });

      const res = run(home, ['list', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.exitCode).toBe(2);
      expect(entry.failureReason).toBe('command exited with code 2');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('can report overdue independently of a completed zero-exit latest run', () => {
    const home = makeHome({
      // createdAt predates the run below, so the routine is old enough for a
      // missed occurrence to count (overdue is floored at routine creation).
      jobs: [{ ...baseJob, schedule: '* * * * *', createdAt: '2026-07-01T00:00:00.000Z' }],
      registry,
    });
    try {
      writeRunMeta(home, 'test-job', '2026-07-20T03-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-20T03-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'completed',
        startedAt: '2026-07-20T03:00:00.000Z',
        completedAt: '2026-07-20T03:00:05.000Z',
        exitCode: 0,
      });

      const res = run(home, ['list', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.overdue).toBe(true);
      expect(entry.lastStatus).toBe('completed');
      expect(entry.exitCode).toBe(0);
      expect(entry.failureReason).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // A routine re-pinned to other devices leaves its old run records behind on
  // the machine that used to fire it. Reporting those as the routine's status
  // painted a peer's healthy routine red in `list` and in the menu bar (which
  // reads this JSON) — the record describes this device, not the owner.
  it('reports no status for a routine pinned away from this device', () => {
    const home = makeHome({
      jobs: [
        { ...baseJob, name: 'pinned-elsewhere', devices: ['yosemite-s0'] },
        { ...baseJob, name: 'pinned-here', devices: ['zion'] },
      ],
      registry,
    });
    try {
      for (const name of ['pinned-elsewhere', 'pinned-here']) {
        writeRunMeta(home, name, '2026-07-25T10-00-00-000Z', {
          jobName: name,
          runId: '2026-07-25T10-00-00-000Z',
          agent: 'claude',
          pid: null,
          status: 'failed',
          startedAt: '2026-07-25T10:00:00.000Z',
          completedAt: '2026-07-25T10:00:05.000Z',
          exitCode: 1,
          errorMessage: 'command exited with code 1',
        });
      }

      const res = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout.trim());

      const elsewhere = parsed.find((j: Record<string, unknown>) => j.name === 'pinned-elsewhere');
      expect(elsewhere.runsHere).toBe(false);
      expect(elsewhere.lastStatus).toBeNull();
      expect(elsewhere.exitCode).toBeNull();
      expect(elsewhere.failureReason).toBeNull();
      expect(elsewhere.lastRunStartedAt).toBeNull();
      expect(elsewhere.lastRunCompletedAt).toBeNull();

      // The same record on a routine this device does fire is still reported.
      const here = parsed.find((j: Record<string, unknown>) => j.name === 'pinned-here');
      expect(here.runsHere).toBe(true);
      expect(here.lastStatus).toBe('failed');
      expect(here.exitCode).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines runs --json', () => {
  it('emits run ids and statuses for the requested routine', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      writeRunMeta(home, 'test-job', '2026-07-21T10-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'completed',
        startedAt: '2026-07-21T10:00:00.000Z',
        completedAt: '2026-07-21T10:00:05.000Z',
        exitCode: 0,
      });
      writeRunMeta(home, 'test-job', '2026-07-21T11-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T11-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'failed',
        startedAt: '2026-07-21T11:00:00.000Z',
        completedAt: '2026-07-21T11:00:05.000Z',
        exitCode: 1,
        errorMessage: 'command exited with code 1',
      });

      const res = run(home, ['runs', 'test-job', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.jobId).toBe('test-job');
      expect(parsed.runs).toHaveLength(2);
      expect(parsed.runs[0]).toMatchObject({
        jobId: 'test-job',
        runId: '2026-07-21T10-00-00-000Z',
        status: 'completed',
        exitCode: 0,
      });
      expect(parsed.runs[1]).toMatchObject({
        jobId: 'test-job',
        runId: '2026-07-21T11-00-00-000Z',
        status: 'failed',
        exitCode: 1,
        errorMessage: 'command exited with code 1',
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list table has Devices column with bounded ellipsis', () => {
  it('table header includes Devices', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['list', '--flat']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Devices');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('long device lists are ellipsized in the table', () => {
    const job = { ...baseJob, devices: ['yosemite-s0', 'yosemite-s1', 'mac-mini', 'zion'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: {
        'yosemite-s0': ['test-job'],
        'yosemite-s1': ['test-job'],
        'mac-mini': ['test-job'],
        zion: ['test-job'],
      },
    });
    try {
      const res = run(home, ['list', '--flat']);
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const lines = stripped.split('\n').filter((l) => l.includes('test-job'));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/…/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('renders unrestricted routines with Devices set to "all"', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['list', '--flat']);
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const lines = stripped.split('\n');
      const line = lines.find((l) => l.includes('test-job'));
      expect(line).toBeDefined();
      const headerLine = lines.find((l) => l.includes('Devices') && l.includes('Schedule'));
      expect(headerLine).toBeDefined();
      const deviceStart = headerLine!.indexOf('Devices');
      const scheduleStart = headerLine!.indexOf('Schedule');
      expect(deviceStart).toBeGreaterThan(-1);
      expect(scheduleStart).toBeGreaterThan(deviceStart);
      const deviceField = line!.slice(deviceStart, scheduleStart).trim();
      expect(deviceField).toBe('all');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('marks one-shot routines in the schedule column', () => {
    const job = { ...baseJob, schedule: '0 14 31 12 *', runOnce: true };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['list', '--flat']);
      expect(res.status).toBe(0);
      expect(res.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toContain('one-shot');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list grouped by device', () => {
  it('groups by fleet, current device, pinned devices, hosts, cloud, and offline registry state', () => {
    const jobs = [
      { ...baseJob, name: 'all-local' },
      { ...baseJob, name: 'zion-local', devices: ['zion'] },
      { ...baseJob, name: 's0-local', devices: ['yosemite-s0'] },
      { ...baseJob, name: 'fleet-placed', hostStrategy: 'fleet', devices: ['zion'] },
      { ...baseJob, name: 'cloud-placed', hostStrategy: 'cloud', devices: ['zion'] },
      { ...baseJob, name: 'host-placed', hostStrategy: 'host', host: 'mac-mini', devices: ['zion'] },
      { ...baseJob, name: 'offline-local', devices: ['offline-box'] },
    ];
    const groupedRegistry = {
      ...registry,
      'mac-mini': { ...registry['mac-mini'], tailscale: { online: false, direct: false } },
      'offline-box': { name: 'offline-box', platform: 'linux', tailscale: { online: false, direct: false } },
    };
    const home = makeHome({
      jobs,
      registry: groupedRegistry,
      deviceRoutines: {
        zion: ['zion-local', 'fleet-placed', 'cloud-placed', 'host-placed'],
        'yosemite-s0': ['s0-local'],
        'offline-box': ['offline-local'],
      },
    });
    try {
      const res = run(home, ['list', '--group-by', 'device'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toContain('This machine (zion)');
      expect(stripped).toContain('Fleet-wide');
      expect(stripped).toContain('Cloud');
      expect(stripped).toContain('Device: yosemite-s0');
      expect(stripped).toContain('Device: offline-box (offline)');
      expect(stripped).toContain('Host: mac-mini (offline)');
      for (const job of jobs) expect(stripped).toContain(job.name);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // One routine pinned to two devices renders a row under each. Only the row
  // under THIS machine may carry Last Status — the peer's row previously
  // repeated our local record, which is how a green routine showed up red.
  it('shows Last Status only under this machine, not under a peer device', () => {
    const home = makeHome({
      // Deliberately a two-device pin: the point here is that the listing still
      // renders a row under EACH device group, and only the This-machine row
      // carries a status. (Ownership means only zion fires it; the peer row
      // existing is what this test is about.)
      // zion must be the OWNER (lowest normalized name) so its row carries a
      // status, while a second device still renders a peer group — that peer
      // row having no status is what this test asserts.
      jobs: [{ ...baseJob, name: 'two-device-job' }],
      registry: { ...registry, 'zulu-box': { name: 'zulu-box', platform: 'linux' } },
      deviceRoutines: { zion: ['two-device-job'], 'zulu-box': ['two-device-job'] },
    });
    try {
      writeRunMeta(home, 'two-device-job', '2026-07-25T10-00-00-000Z', {
        jobName: 'two-device-job',
        runId: '2026-07-25T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'failed',
        startedAt: '2026-07-25T10:00:00.000Z',
        completedAt: '2026-07-25T10:00:05.000Z',
        exitCode: 1,
      });

      const res = run(home, ['list', '--group-by', 'device'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');

      const lines = stripped.split('\n');
      const mineIdx = lines.findIndex((l) => l.includes('This machine (zion)'));
      const peerIdx = lines.findIndex((l) => l.includes('Device: zulu-box'));
      expect(mineIdx).toBeGreaterThanOrEqual(0);
      expect(peerIdx).toBeGreaterThanOrEqual(0);

      const rowAfter = (start: number): string =>
        lines.slice(start).find((l) => l.includes('two-device-job')) ?? '';
      expect(rowAfter(mineIdx)).toContain('failed');
      expect(rowAfter(peerIdx)).not.toContain('failed');
      expect(stripped).toContain('Last Status is per-device');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('defaults to project grouping; --group-by device restores device view; --flat disables grouping', () => {
    const home = makeHome({ jobs: [baseJob], registry, deviceRoutines: { zion: ['test-job'] } });
    try {
      const byProject = run(home, ['list'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      const byDevice = run(home, ['list', '--group-by', 'device'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      const flat = run(home, ['list', '--flat'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(byProject.status).toBe(0);
      expect(byDevice.status).toBe(0);
      expect(flat.status).toBe(0);
      // Default (project): job has no projects, lands in Operations section
      expect(byProject.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toContain('Operations');
      expect(byProject.stdout.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('This machine (zion)');
      // Explicit device grouping: shows device sections
      expect(byDevice.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toContain('This machine (zion)');
      // Flat: no section headers
      expect(flat.stdout.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('This machine (zion)');
      expect(flat.stdout.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('Operations');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines cleanup', () => {
  it('removes completed expired one-shot-looking routines', () => {
    const year = new Date().getFullYear();
    const job = { ...baseJob, name: 'stale-followup', schedule: '0 0 1 1 *' };
    const home = makeHome({ jobs: [job], registry });
    writeRunMeta(home, 'stale-followup', `${year}-01-02T00-00-00-000Z`, {
      jobName: 'stale-followup',
      runId: `${year}-01-02T00-00-00-000Z`,
      agent: 'claude',
      pid: null,
      status: 'completed',
      startedAt: `${year}-01-02T00:00:00.000Z`,
      completedAt: `${year}-01-02T00:00:01.000Z`,
      exitCode: 0,
    });
    try {
      const dryRun = run(home, ['cleanup', '--dry-run']);
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain('stale-followup');
      expect(readRoutineYaml(home, 'stale-followup')).not.toBeNull();

      const res = run(home, ['cleanup']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Removed stale-followup');
      expect(readRoutineYaml(home, 'stale-followup')).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices no-flags nonTTY names --set/--clear', () => {
  it('non-interactive devices without flags exits nonzero naming --set and --clear', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['devices', 'test-job']);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/--set/);
      expect(output).toMatch(/--clear/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list --host self runs locally', () => {
  it('exits 0 and lists when --host matches AGENTS_SYNC_MACHINE_ID', () => {
    const job = { ...baseJob, devices: ['zion'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['list', '--host', 'zion'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines --help documents --host and --device', () => {
  it('help output contains --host and --device', () => {
    const home = makeHome();
    try {
      const res = run(home, ['--help']);
      const output = res.stdout + res.stderr;
      expect(output).toContain('--host');
      expect(output).toContain('--device');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set and --clear are mutually exclusive', () => {
  it('exits nonzero without mutation when both are given', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      const res = run(home, ['devices', 'test-job', '--set', 'mac-mini', '--clear']);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/mutually exclusive/);
      const after = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --devices empty/whitespace fails closed', () => {
  it('rejects --devices "" and does not create the routine file', () => {
    const home = makeHome({ registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const res = run(home, [
        'add', 'new-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--devices', '',
      ]);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/--devices requires at least one non-empty device name/);
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'new-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects --devices "   " and does not create the routine file', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'space-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--devices', '   ',
      ]);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/--devices requires at least one non-empty device name/);
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'space-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('successfully persists --devices with valid names against a running daemon', async () => {
    const home = makeHome({ registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      const res = run(home, [
        'add', 'placed-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--devices', 'yosemite-s0',
      ], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);
      const doc = readRoutineYaml(home, 'placed-job');
      expect(doc).not.toBeNull();
      expect(doc!.devices).toBeUndefined();
      expect(readDeviceRoutines(home, 'yosemite-s0')).toContain('placed-job');
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (typeof pid === 'number') expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set empty/whitespace fails closed', () => {
  it('rejects --set "" without mutating the routine', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      const res = run(home, ['devices', 'test-job', '--set', '']);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/--devices requires at least one non-empty device name/);
      const after = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects --set "" combined with --clear as mutually exclusive', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      const res = run(home, ['devices', 'test-job', '--set', '', '--clear']);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/mutually exclusive/);
      const after = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines run wrong-host exact output', () => {
  it('prints the canonical message and suggestion then exits nonzero', () => {
    const job = { ...baseJob, devices: ['yosemite-s0', 'mac-mini'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['run', 'test-job'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toContain("Job 'test-job' can only run on: yosemite-s0, mac-mini");
      // The suggested host is the OWNER (lowest normalized name), not the first
      // entry as written — the old suggestion pointed at a box that would refuse
      // the run for exactly the same reason.
      expect(output).toContain('  agents routines run test-job --host mac-mini');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list --help documents --host and --device once each', () => {
  it('lists each routing flag exactly once', () => {
    const home = makeHome();
    try {
      const res = run(home, ['list', '--help']);
      expect(res.status).toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toContain('--host');
      expect(output).toContain('--device');
      const hostMatches = output.match(/^\s+-H, --host /gm) ?? [];
      const deviceMatches = output.match(/^\s+--device /gm) ?? [];
      expect(hostMatches.length).toBe(1);
      expect(deviceMatches.length).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

/** Parse direct subcommand names from `routines --help`. */
function directSubcommandNames(home: string): string[] {
  const res = run(home, ['--help']);
  expect(res.status).toBe(0);
  const output = res.stdout + res.stderr;
  const commandsMatch = output.match(/Commands:\n([\s\S]*?)(?=\n(?:Options|Notes|Examples|Arguments):)/);
  if (!commandsMatch) return [];
  return commandsMatch[1]
    .split('\n')
    .map((line) => line.match(/^  ([a-z][a-z0-9-]*)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

describeRoutines('routines subcommand --help documents --host and --device once each', () => {
  it('derives every direct command from routines --help and checks local help', () => {
    const home = makeHome();
    try {
      const names = directSubcommandNames(home);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const res = run(home, [name, '--help']);
        expect(res.status).toBe(0);
        const output = res.stdout + res.stderr;
        const hostMatches = output.match(/^\s+-H, --host /gm) ?? [];
        const deviceMatches = output.match(/^\s+--device /gm) ?? [];
        expect(hostMatches.length).toBe(1);
        expect(deviceMatches.length).toBe(1);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    // ~15 subcommands, each a cold `node --import tsx` boot; Windows subprocess
    // spawn is slow enough to tip the aggregate over the 30s global timeout.
  }, 90_000);
});

describeRoutines('routines run --host SELF follows the normal local eligibility path', () => {
  it('passes device eligibility when self is in the allowlist', () => {
    const job = { ...baseJob, devices: ['zion'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['run', 'test-job', '--host', 'zion'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      // Eligibility passes; the run then fails because no claude version is
      // configured in the isolated HOME. The important thing is it did not fail
      // with the device-mismatch message.
      const output = res.stdout + res.stderr;
      expect(output).not.toContain("Job 'test-job' can only run on");
      expect(output).toMatch(/no version of claude configured|not installed|spawn failed/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines run --json', () => {
  it('emits the real run id and status for a command routine', () => {
    const home = makeHome({
      jobs: [{
        name: 'command-job',
        schedule: '0 3 * * *',
        command: 'printf ok',
        mode: 'auto',
        effort: 'auto',
        timeout: '10m',
        enabled: true,
        prompt: '',
      }],
      registry,
    });
    try {
      const res = run(home, ['run', 'command-job', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed).toMatchObject({
        jobId: 'command-job',
        jobName: 'command-job',
        status: 'completed',
        exitCode: 0,
        errorMessage: null,
      });
      expect(typeof parsed.runId).toBe('string');
      expect(parsed.runId.length).toBeGreaterThan(0);
      expect(parsed.logPath).toContain(parsed.runId);
      expect(parsed.reportPath).toBeNull();

      const runsRes = run(home, ['runs', 'command-job', '--json']);
      expect(runsRes.status).toBe(0);
      const runs = JSON.parse(runsRes.stdout.trim());
      expect(runs.runs).toHaveLength(1);
      expect(runs.runs[0]).toMatchObject({
        runId: parsed.runId,
        status: 'completed',
        exitCode: 0,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('buildRunsJson', () => {
  const meta = (runId: string, status: RunMeta['status'], startedAt: string): RunMeta => ({
    jobName: 'test-job',
    runId,
    pid: null,
    status,
    startedAt,
    completedAt: null,
    exitCode: null,
  });

  it('projects each run to the rich JSON fields used by routines runs --json', () => {
    const runs = [
      meta('r1', 'completed', '2026-07-20T00:00:00Z'),
      meta('r2', 'failed', '2026-07-21T00:00:00Z'),
    ];
    expect(buildRunsJson(runs)).toEqual([
      {
        jobId: 'test-job',
        jobName: 'test-job',
        runId: 'r1',
        status: 'completed',
        startedAt: '2026-07-20T00:00:00Z',
        completedAt: null,
        exitCode: null,
        errorMessage: null,
        duration: null,
      },
      {
        jobId: 'test-job',
        jobName: 'test-job',
        runId: 'r2',
        status: 'failed',
        startedAt: '2026-07-21T00:00:00Z',
        completedAt: null,
        exitCode: null,
        errorMessage: null,
        duration: null,
      },
    ]);
  });

  it('returns an empty array for no runs', () => {
    expect(buildRunsJson([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Project-tagging tests (--project / --all-projects / list --json projectGroup)
// ---------------------------------------------------------------------------

/** Write a minimal project YAML so listProjectDefs() sees it. */
function writeProject(home: string, name: string): void {
  const dir = path.join(home, '.agents', 'projects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml.stringify({ name }));
}

/** Env that points the projects dir at the isolated home. */
function projectsEnv(home: string): Record<string, string> {
  return { AGENTS_PROJECTS_DIR: path.join(home, '.agents', 'projects') };
}

describeRoutines('routines add --project persists to YAML', () => {
  it('writes a single project name into the projects field', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    try {
      const res = run(home, [
        'add', 'proj-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'run tests',
        '--project', 'myapp',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status, res.stderr).toBe(0);
      const doc = readRoutineYaml(home, 'proj-job');
      expect(doc).not.toBeNull();
      expect(doc!.projects).toEqual(['myapp']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes multiple --project values as an array', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    writeProject(home, 'billing');
    try {
      const res = run(home, [
        'add', 'multi-proj-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'run tests',
        '--project', 'myapp',
        '--project', 'billing',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status, res.stderr).toBe(0);
      const doc = readRoutineYaml(home, 'multi-proj-job');
      expect(doc).not.toBeNull();
      expect(doc!.projects).toEqual(['myapp', 'billing']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated project names, preserving first-seen order', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    try {
      const res = run(home, [
        'add', 'dedup-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'run tests',
        '--project', 'myapp',
        '--project', 'myapp',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status, res.stderr).toBe(0);
      const doc = readRoutineYaml(home, 'dedup-job');
      expect(doc).not.toBeNull();
      expect(doc!.projects).toEqual(['myapp']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --all-projects', () => {
  it('writes projects: ["*"] to YAML', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    try {
      const res = run(home, [
        'add', 'all-proj-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'fleet check',
        '--all-projects',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status, res.stderr).toBe(0);
      const doc = readRoutineYaml(home, 'all-proj-job');
      expect(doc).not.toBeNull();
      expect(doc!.projects).toEqual(['*']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects --all-projects combined with --project', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    try {
      const res = run(home, [
        'add', 'conflict-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'check',
        '--all-projects',
        '--project', 'myapp',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/mutually exclusive/);
      expect(readRoutineYaml(home, 'conflict-job')).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --project unknown project rejection', () => {
  it('rejects an unknown project name and does not create the routine file', () => {
    const home = makeHome({ registry });
    // No projects written — "ghost" does not exist.
    try {
      const res = run(home, [
        'add', 'ghost-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'check',
        '--project', 'ghost',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/Unknown project/i);
      expect(readRoutineYaml(home, 'ghost-job')).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('groupRoutineJobsByProject — named projects never collide with special buckets', () => {
  const mk = (name: string, projects?: string[]): JobConfig =>
    ({ ...baseJob, name, ...(projects ? { projects } : {}) }) as unknown as JobConfig;

  it('keeps a project named "Operations" separate from the no-project Operations special', () => {
    const known = new Set(['Operations']);
    const jobs = [
      mk('in-operations-project', ['Operations']), // named project literally "Operations"
      mk('no-project'),                             // untagged -> special Operations bucket
    ];
    const groups = groupRoutineJobsByProject(jobs, known);
    const named = groups.find((g) => g.key === 'named:Operations');
    const special = groups.find((g) => g.key === 'special:operations');
    // Two distinct buckets, both titled "Operations", never merged.
    expect(named).toBeDefined();
    expect(special).toBeDefined();
    expect(named!.jobs.map((j) => j.name)).toEqual(['in-operations-project']);
    expect(special!.jobs.map((j) => j.name)).toEqual(['no-project']);
    // The named project sorts before the special that shares its title.
    expect(groups.indexOf(named!)).toBeLessThan(groups.indexOf(special!));
  });

  it('keeps a project named "Cross-project" separate from the multi-project span special', () => {
    const known = new Set(['Cross-project', 'a', 'b']);
    const jobs = [
      mk('in-crossproject-project', ['Cross-project']), // named project literally "Cross-project"
      mk('spans-two', ['a', 'b']),                       // multiple names -> special Cross-project bucket
    ];
    const groups = groupRoutineJobsByProject(jobs, known);
    const named = groups.find((g) => g.key === 'named:Cross-project');
    const special = groups.find((g) => g.key === 'special:cross');
    expect(named).toBeDefined();
    expect(special).toBeDefined();
    expect(named!.jobs.map((j) => j.name)).toEqual(['in-crossproject-project']);
    expect(special!.jobs.map((j) => j.name)).toEqual(['spans-two']);
    expect(groups.indexOf(named!)).toBeLessThan(groups.indexOf(special!));
  });

  it('orders named projects (alphabetically) before All projects, Cross-project, Operations, Unknown projects', () => {
    const known = new Set(['zeta', 'alpha', 'a', 'b']);
    const jobs = [
      mk('op'),                       // Operations special
      mk('unknown', ['ghost']),       // Unknown projects special
      mk('all', ['*']),               // All projects special
      mk('cross', ['a', 'b']),        // Cross-project special
      mk('named-z', ['zeta']),        // named
      mk('named-a', ['alpha']),       // named
    ];
    const titles = groupRoutineJobsByProject(jobs, known).map((g) => g.title);
    expect(titles).toEqual(['alpha', 'zeta', 'All projects', 'Cross-project', 'Operations', 'Unknown projects']);
  });

  it('groups a file-style duplicate-name routine (projects: [myapp, myapp]) as the single named project', () => {
    const known = new Set(['myapp']);
    const groups = groupRoutineJobsByProject([mk('dup', ['myapp', 'myapp'])], known);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('named:myapp');
    expect(groups[0].title).toBe('myapp');
  });
});

describeRoutines('routines list --json projects and projectGroup fields', () => {
  it('includes projects and projectGroup in the JSON payload', () => {
    const jobWithProject = { ...baseJob, name: 'tagged-job', projects: ['myapp'] };
    const jobNoProject = { ...baseJob, name: 'untagged-job' };
    const home = makeHome({
      jobs: [jobWithProject, jobNoProject],
      registry,
      deviceRoutines: { zion: ['tagged-job', 'untagged-job'] },
    });
    writeProject(home, 'myapp');
    try {
      const res = run(home, ['list', '--json'], {
        ...projectsEnv(home),
        AGENTS_SYNC_MACHINE_ID: 'zion',
      });
      expect(res.status, res.stderr).toBe(0);
      const payload = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
      const tagged = payload.find((j) => j.name === 'tagged-job');
      const untagged = payload.find((j) => j.name === 'untagged-job');
      expect(tagged).toBeDefined();
      expect(tagged!.projects).toEqual(['myapp']);
      expect(tagged!.projectGroup).toBe('myapp');
      expect(untagged).toBeDefined();
      expect(untagged!.projects).toEqual([]);
      expect(untagged!.projectGroup).toBe('Operations');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports projectGroup as "All projects" for projects: ["*"]', () => {
    const jobAllProjects = { ...baseJob, name: 'all-proj-job', projects: ['*'] };
    const home = makeHome({
      jobs: [jobAllProjects],
      registry,
      deviceRoutines: { zion: ['all-proj-job'] },
    });
    try {
      const res = run(home, ['list', '--json'], {
        ...projectsEnv(home),
        AGENTS_SYNC_MACHINE_ID: 'zion',
      });
      expect(res.status, res.stderr).toBe(0);
      const payload = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
      const entry = payload.find((j) => j.name === 'all-proj-job');
      expect(entry).toBeDefined();
      expect(entry!.projects).toEqual(['*']);
      expect(entry!.projectGroup).toBe('All projects');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
