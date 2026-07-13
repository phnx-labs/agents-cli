/**
 * End-to-end CLI subprocess tests for `agents routines` device-affinity commands.
 *
 * Every test spawns the real CLI (`node --import tsx src/index.ts routines ...`)
 * against an isolated mkdtemp HOME — no live ~/.agents state, no mocks, no
 * imported writeJob/readJob. Modeled on `routines-webhook.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Provision an isolated HOME with agents.yaml, .system/.git, and optional routines + device registry. */
function makeHome(opts: {
  jobs?: Record<string, unknown>[];
  registry?: Record<string, unknown>;
} = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-routines-test-'));
  const agentsDir = path.join(home, '.agents');
  const routinesDir = path.join(agentsDir, 'routines');
  fs.mkdirSync(routinesDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'agents.yaml'), 'agents: {}\n');
  fs.mkdirSync(path.join(agentsDir, '.system', '.git'), { recursive: true });

  for (const job of opts.jobs ?? []) {
    fs.writeFileSync(
      path.join(routinesDir, `${job.name}.yml`),
      yaml.stringify(job),
    );
  }

  if (opts.registry) {
    const devicesDir = path.join(agentsDir, '.history', 'devices');
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(path.join(devicesDir, 'registry.json'), JSON.stringify(opts.registry));
  }

  return home;
}

/** Run `agents routines <args>` against an isolated HOME. */
function run(home: string, args: string[], extraEnv: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', 'routines', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
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

const baseJob = {
  name: 'test-job',
  schedule: '0 3 * * *',
  agent: 'claude',
  prompt: 'noop',
};

const registry = {
  'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
  'mac-mini': { name: 'mac-mini', platform: 'macos' },
  'zion': { name: 'zion', platform: 'macos' },
};

describe('routines devices --set persists', () => {
  it('writes a devices allowlist to the routine YAML', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'yosemite-s0,mac-mini']);
      expect(res.status).toBe(0);

      const doc = readRoutineYaml(home, 'test-job');
      expect(doc).not.toBeNull();
      expect(doc!.devices).toEqual(['yosemite-s0', 'mac-mini']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('routines devices --clear removes allowlist', () => {
  it('removes the devices field from the routine YAML', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['devices', 'test-job', '--clear']);
      expect(res.status).toBe(0);

      const raw = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(raw).not.toMatch(/^devices:/m);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('routines devices --set unknown is nonzero/no mutation', () => {
  it('rejects unknown device names and does not mutate the YAML', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry });
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

describe('routines add --devices unknown is nonzero/no write', () => {
  it('rejects unknown devices and does not create the routine file', () => {
    const home = makeHome({ registry });
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

describe('routines list --json has devices+runsHere, no device', () => {
  it('includes devices array and runsHere, excludes singular device key', () => {
    const job = { ...baseJob, devices: ['yosemite-s0', 'mac-mini'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual(['yosemite-s0', 'mac-mini']);
      expect(typeof entry.runsHere).toBe('boolean');
      expect(entry.runsHere).toBe(true);
      expect('device' in entry).toBe(false);
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
});

describe('routines list table has Devices column with bounded ellipsis', () => {
  it('table header includes Devices', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['list']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Devices');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('long device lists are ellipsized in the table', () => {
    const job = { ...baseJob, devices: ['yosemite-s0', 'yosemite-s1', 'mac-mini', 'zion'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['list']);
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const lines = stripped.split('\n').filter((l) => l.includes('test-job'));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/…/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('routines devices no-flags nonTTY names --set/--clear', () => {
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

describe('routines list --host self runs locally', () => {
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

describe('routines --help documents --host and --device', () => {
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

describe('routines devices --set and --clear are mutually exclusive', () => {
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

describe('routines add --devices empty/whitespace fails closed', () => {
  it('rejects --devices "" and does not create the routine file', () => {
    const home = makeHome({ registry });
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

  it('successfully persists --devices with valid names', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'placed-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--devices', 'yosemite-s0,mac-mini',
      ]);
      expect(res.status).toBe(0);
      const doc = readRoutineYaml(home, 'placed-job');
      expect(doc).not.toBeNull();
      expect(doc!.devices).toEqual(['yosemite-s0', 'mac-mini']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('routines devices --set empty/whitespace fails closed', () => {
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

describe('routines run wrong-host exact output', () => {
  it('prints the canonical message and suggestion then exits nonzero', () => {
    const job = { ...baseJob, devices: ['yosemite-s0', 'mac-mini'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['run', 'test-job'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toContain("Job 'test-job' can only run on: yosemite-s0, mac-mini");
      expect(output).toContain('  agents routines run test-job --host yosemite-s0');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('routines list --help documents --host and --device once each', () => {
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

describe('routines run --host SELF follows the normal local eligibility path', () => {
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
