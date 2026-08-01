import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as state from '../state.js';
import {
  enableProjectRoutines,
  disableProjectRoutines,
  syncProjectRoutines,
  listEnabledProjectRoots,
  isProjectRoutinesEnabled,
  expandProjectPath,
} from '../routines-project.js';
import { listJobs, readJob, resolveHostStrategy, parseHostStrategy, placementRequiresFiringPin } from '../routines.js';
import { resolvePlacementTarget, pickFleetDevice } from '../routines-placement.js';
import type { JobConfig } from '../routines.js';

let tmpDir = '';
let projectDir = '';
let projectRoutinesDir = '';
let userRoutinesDir = '';
let systemRoutinesDir = '';
let userAgentsDir = '';

function writeRoutine(dir: string, name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yml`), yaml.stringify(body), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-project-sync-'));
  projectDir = path.join(tmpDir, 'project');
  projectRoutinesDir = path.join(projectDir, '.agents', 'routines');
  userRoutinesDir = path.join(tmpDir, 'user-routines');
  systemRoutinesDir = path.join(tmpDir, 'system-routines');
  userAgentsDir = path.join(tmpDir, 'user-agents');

  fs.mkdirSync(projectRoutinesDir, { recursive: true });
  fs.mkdirSync(userRoutinesDir, { recursive: true });
  fs.mkdirSync(systemRoutinesDir, { recursive: true });
  fs.mkdirSync(userAgentsDir, { recursive: true });
  fs.writeFileSync(path.join(userAgentsDir, 'agents.yaml'), 'routines: {}\n', 'utf-8');

  vi.spyOn(state, 'getRoutinesDir').mockReturnValue(userRoutinesDir);
  vi.spyOn(state, 'getSystemRoutinesDir').mockReturnValue(systemRoutinesDir);
  vi.spyOn(state, 'getProjectRoutinesDir').mockImplementation((cwd?: string) => {
    if (!cwd) return null;
    if (path.resolve(cwd).startsWith(projectDir) || path.resolve(cwd) === projectDir) {
      return projectRoutinesDir;
    }
    return null;
  });
  vi.spyOn(state, 'getProjectAgentsDir').mockImplementation((start?: string) => {
    const s = path.resolve(start ?? process.cwd());
    if (s === projectDir || s.startsWith(projectDir + path.sep)) {
      return path.join(projectDir, '.agents');
    }
    return null;
  });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(userAgentsDir);
  vi.spyOn(state, 'ensureAgentsDir').mockImplementation(() => {});

  // Route meta read/write through the temp agents.yaml.
  const metaPath = path.join(userAgentsDir, 'agents.yaml');
  vi.spyOn(state, 'readMeta').mockImplementation(() => {
    try {
      return yaml.parse(fs.readFileSync(metaPath, 'utf-8')) ?? {};
    } catch {
      return {};
    }
  });
  vi.spyOn(state, 'writeMeta').mockImplementation((meta) => {
    fs.writeFileSync(metaPath, yaml.stringify(meta), 'utf-8');
  });
  vi.spyOn(state, 'updateMeta').mockImplementation((updates) => {
    const cur = state.readMeta();
    const next = typeof updates === 'function' ? updates(cur) : { ...cur, ...updates };
    state.writeMeta(next);
    return next;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hostStrategy helpers', () => {
  it('resolveHostStrategy defaults to local, infers host from host:', () => {
    expect(resolveHostStrategy({})).toBe('local');
    expect(resolveHostStrategy({ host: 'gpu-box' })).toBe('host');
    expect(resolveHostStrategy({ hostStrategy: 'fleet' })).toBe('fleet');
    expect(resolveHostStrategy({ hostStrategy: 'cloud', host: 'x' })).toBe('cloud');
  });

  it('parseHostStrategy accepts known values and rejects unknowns', () => {
    expect(parseHostStrategy('fleet')).toBe('fleet');
    expect(parseHostStrategy('LOCAL')).toBe('local');
    expect(parseHostStrategy(undefined)).toBeNull();
    expect(() => parseHostStrategy('everywhere')).toThrow(/Invalid placement/);
  });

  it('placementRequiresFiringPin is true for host/fleet/cloud', () => {
    expect(placementRequiresFiringPin('local')).toBe(false);
    expect(placementRequiresFiringPin('host')).toBe(true);
    expect(placementRequiresFiringPin('fleet')).toBe(true);
    expect(placementRequiresFiringPin('cloud')).toBe(true);
  });
});

describe('project opt-in + source tracking', () => {
  it('enableProjectRoutines records the project root and isProjectRoutinesEnabled reflects it', () => {
    expect(isProjectRoutinesEnabled(projectDir)).toBe(false);
    const added = enableProjectRoutines(projectDir);
    expect(added).toBe(true);
    expect(isProjectRoutinesEnabled(projectDir)).toBe(true);
    expect(listEnabledProjectRoots()).toContain(expandProjectPath(projectDir));
    // Idempotent
    expect(enableProjectRoutines(projectDir)).toBe(false);
  });

  it('sync materialises project YAML into the user layer with source provenance', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'review the project',
    });
    enableProjectRoutines(projectDir);
    const result = syncProjectRoutines(projectDir);
    expect(result.synced).toEqual(['daily']);
    expect(result.errors).toEqual([]);

    const job = readJob('daily');
    expect(job).not.toBeNull();
    expect(job!.prompt).toBe('review the project');
    expect(job!.source?.kind).toBe('project');
    expect(job!.source?.projectPath).toBe(expandProjectPath(projectDir));
  });

  it('sync refreshes an existing project-sourced user copy when YAML changes', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'v1',
    });
    enableProjectRoutines(projectDir);
    syncProjectRoutines(projectDir);
    expect(readJob('daily')!.prompt).toBe('v1');

    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'v2',
    });
    syncProjectRoutines(projectDir);
    expect(readJob('daily')!.prompt).toBe('v2');
  });

  it('sync does not overwrite a hand-authored user routine of the same name', () => {
    writeRoutine(userRoutinesDir, 'daily', {
      schedule: '0 8 * * *',
      agent: 'claude',
      prompt: 'user-owned',
    });
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'project-owned',
    });
    enableProjectRoutines(projectDir);
    const result = syncProjectRoutines(projectDir);
    expect(result.skipped.map((s) => s.name)).toContain('daily');
    expect(readJob('daily')!.prompt).toBe('user-owned');
  });

  it('sync removes user copies when project YAML disappears', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'gone soon',
    });
    enableProjectRoutines(projectDir);
    syncProjectRoutines(projectDir);
    expect(readJob('daily')).not.toBeNull();

    fs.unlinkSync(path.join(projectRoutinesDir, 'daily.yml'));
    const result = syncProjectRoutines(projectDir);
    expect(result.removed).toContain('daily');
    expect(readJob('daily')).toBeNull();
  });

  it('disableProjectRoutines drops the allowlist entry and optionally removes synced jobs', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'x',
    });
    enableProjectRoutines(projectDir);
    syncProjectRoutines(projectDir);
    const result = disableProjectRoutines(projectDir, { removeSynced: true });
    expect(result.removed).toBe(true);
    expect(result.deletedJobs).toContain('daily');
    expect(isProjectRoutinesEnabled(projectDir)).toBe(false);
    expect(readJob('daily')).toBeNull();
  });

  it('sync auto-pins devices for fleet/cloud/host placement', () => {
    writeRoutine(projectRoutinesDir, 'fleet-job', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'pick a box',
      hostStrategy: 'fleet',
    });
    enableProjectRoutines(projectDir);
    syncProjectRoutines(projectDir);
    const job = readJob('fleet-job')!;
    expect(job.devices).toBeDefined();
    expect(job.devices!.length).toBe(1);
    expect(job.hostStrategy).toBe('fleet');
  });
});

describe('placement resolution', () => {
  it('local stays local; host self is local; host remote is host', async () => {
    const local = resolvePlacementTarget({
      name: 'a', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      hostStrategy: 'local',
    } as JobConfig);
    expect(local).toEqual({ mode: 'local' });

    const { machineId } = await import('../machine-id.js');
    const self = machineId();
    const hostSelf = resolvePlacementTarget({
      name: 'b', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      hostStrategy: 'host',
      host: self,
    } as JobConfig);
    expect(hostSelf).toEqual({ mode: 'local' });

    const hostRemote = resolvePlacementTarget({
      name: 'c', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      hostStrategy: 'host',
      host: 'some-other-box',
    } as JobConfig);
    expect(hostRemote).toEqual({ mode: 'host', host: 'some-other-box' });
  });

  it('cloud resolves to cloud mode', () => {
    const t = resolvePlacementTarget({
      name: 'd', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      agent: 'claude',
      hostStrategy: 'cloud',
    } as JobConfig);
    expect(t).toEqual({ mode: 'cloud' });
  });

  it('fleet falls back to self when the device registry is empty', () => {
    // pickFleetDevice with empty/missing registry returns machineId().
    // devices pin is fire-only and must not collapse the execution pool.
    const picked = pickFleetDevice({ devices: ['some-other-box'] });
    expect(typeof picked).toBe('string');
    expect(picked!.length).toBeGreaterThan(0);
  });

  it('host strategy without host throws', () => {
    expect(() => resolvePlacementTarget({
      name: 'e', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      hostStrategy: 'host',
    } as JobConfig)).toThrow(/no host/);
  });

  it('fleet with a self fire-pin still resolves (devices is not the execution pool)', async () => {
    const { machineId } = await import('../machine-id.js');
    const self = machineId();
    // Even when devices pins firing to self, fleet may place on any online
    // device — resolvePlacementTarget must not throw and may return local or host.
    const t = resolvePlacementTarget({
      name: 'fleet-pin', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      agent: 'claude',
      hostStrategy: 'fleet',
      devices: [self],
    } as JobConfig);
    expect(t.mode === 'local' || t.mode === 'host').toBe(true);
  });
});

describe('listJobs still excludes unsynced project routines from daemon path', () => {
  it('listJobs() without cwd does not see project-only YAML', () => {
    writeRoutine(projectRoutinesDir, 'project-only', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project',
    });
    // Not enabled / not synced — daemon path must not load it.
    const names = listJobs().map((j) => j.name);
    expect(names).not.toContain('project-only');
  });

  it('after sync, listJobs() (daemon path) sees the materialised copy', () => {
    writeRoutine(projectRoutinesDir, 'project-only', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project',
    });
    enableProjectRoutines(projectDir);
    syncProjectRoutines(projectDir);
    const names = listJobs().map((j) => j.name);
    expect(names).toContain('project-only');
  });
});
