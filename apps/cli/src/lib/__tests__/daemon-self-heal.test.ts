/**
 * Daemon self-heal: heartbeat, wedged detection, path guard, pid-reuse safety.
 * RUSH-1669 / RUSH-1670 / RUSH-1672 / RUSH-1673.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  writeHeartbeat,
  readHeartbeat,
  removeHeartbeat,
  isDaemonWedged,
  writeDaemonPid,
  readDaemonPid,
  removeDaemonPid,
  getDaemonLaunch,
  validateDaemonBinary,
  getDaemonStatus,
} from '../daemon.js';
import { writeRunMeta, type RunMeta } from '../routines.js';
import { getRunsDir } from '../state.js';
import { monitorRunningJobs } from '../runner.js';

// ─── RUSH-1670: Heartbeat + wedged-daemon watchdog ──────────────────────────

describe('heartbeat read/write', () => {
  afterEach(() => { removeHeartbeat(); });

  it('round-trips a heartbeat to disk', () => {
    writeHeartbeat(12345);
    const hb = readHeartbeat();
    expect(hb).not.toBeNull();
    expect(hb!.pid).toBe(12345);
    expect(Date.parse(hb!.lastTick)).toBeGreaterThan(0);
  });

  it('returns null when no heartbeat file exists', () => {
    removeHeartbeat();
    expect(readHeartbeat()).toBeNull();
  });
});

describe('isDaemonWedged', () => {
  let priorPid: number | null;
  beforeEach(() => { priorPid = readDaemonPid(); });
  afterEach(() => {
    removeHeartbeat();
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('returns false when daemon is not running', () => {
    removeDaemonPid();
    expect(isDaemonWedged()).toBe(false);
  });

  it('returns false when heartbeat is fresh (pid alive + recent tick)', () => {
    writeDaemonPid(process.pid);
    writeHeartbeat(process.pid);
    expect(isDaemonWedged()).toBe(false);
  });

  it('returns true when heartbeat is stale (pid alive but tick > 3 minutes old)', () => {
    writeDaemonPid(process.pid);
    const stale = new Date(Date.now() - 4 * 60_000).toISOString();
    const hbPath = path.join(os.homedir(), '.agents', '.cache', 'helpers', 'daemon', 'heartbeat.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ lastTick: stale, pid: process.pid }));
    expect(isDaemonWedged()).toBe(true);
  });
});

describe('getDaemonStatus', () => {
  let priorPid: number | null;
  beforeEach(() => { priorPid = readDaemonPid(); });
  afterEach(() => {
    removeHeartbeat();
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('reports stopped when no daemon is running', () => {
    removeDaemonPid();
    const s = getDaemonStatus();
    expect(s.state).toBe('stopped');
    expect(s.running).toBe(false);
  });

  it('reports running with binary path when daemon is alive and fresh', () => {
    writeDaemonPid(process.pid);
    writeHeartbeat(process.pid);
    const s = getDaemonStatus();
    expect(s.state).toBe('running');
    expect(s.binaryPath).toBeTruthy();
  });

  it('reports wedged when heartbeat is stale', () => {
    writeDaemonPid(process.pid);
    const stale = new Date(Date.now() - 4 * 60_000).toISOString();
    const hbPath = path.join(os.homedir(), '.agents', '.cache', 'helpers', 'daemon', 'heartbeat.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ lastTick: stale, pid: process.pid }));
    const s = getDaemonStatus();
    expect(s.state).toBe('wedged');
  });
});

// ─── RUSH-1672: pid-reuse-safe reaper + max wall-clock ──────────────────────

describe('monitorRunningJobs — pid-reuse + max wall-clock', () => {
  const cleanupDirs: string[] = [];
  afterEach(() => {
    for (const d of cleanupDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('finalizes a run whose pid is dead (basic orphan reap)', () => {
    const meta: RunMeta = {
      jobName: '__selfheal-dead-pid__',
      runId: 'test-dead-1',
      agent: 'claude',
      pid: 999999,
      spawnedAt: Date.now() - 60_000,
      status: 'running',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
    };
    writeRunMeta(meta);
    cleanupDirs.push(path.join(getRunsDir(), meta.jobName));

    monitorRunningJobs();

    const metaPath = path.join(getRunsDir(), meta.jobName, meta.runId, 'meta.json');
    const updated: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(updated.status).not.toBe('running');
    expect(updated.completedAt).not.toBeNull();
  });

  it('finalizes a run that exceeds the 24h max wall-clock', () => {
    const meta: RunMeta = {
      jobName: '__selfheal-wallclock__',
      runId: 'test-wall-1',
      agent: 'claude',
      pid: process.pid,
      spawnedAt: Date.now(),
      status: 'running',
      startedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
    };
    writeRunMeta(meta);
    cleanupDirs.push(path.join(getRunsDir(), meta.jobName));

    monitorRunningJobs();

    const metaPath = path.join(getRunsDir(), meta.jobName, meta.runId, 'meta.json');
    const updated: RunMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(updated.status).toBe('timeout');
    expect(updated.completedAt).not.toBeNull();
  });
});

// ─── RUSH-1673: path guard (never supervise worktree/bunfs daemon) ──────────

describe('validateDaemonBinary — path guard', () => {
  it('throws for a /$bunfs/root/ virtual path', () => {
    expect(() => validateDaemonBinary('/$bunfs/root/agents')).toThrow(/bun virtual path/);
  });

  it('warns for a binary under .agents/worktrees/', () => {
    const { warnings } = validateDaemonBinary('/home/user/repo/.agents/worktrees/my-branch/apps/cli/dist/index.js');
    expect(warnings.some((w) => /worktree/.test(w))).toBe(true);
  });

  it('warns for a nonexistent native binary', () => {
    const { warnings } = validateDaemonBinary('/nonexistent/agents-never-exists');
    expect(warnings.some((w) => /does not exist/.test(w))).toBe(true);
  });

  it('accepts process.execPath (a real binary) with no warnings', () => {
    const { warnings } = validateDaemonBinary(process.execPath);
    expect(warnings).toHaveLength(0);
  });
});

describe('getDaemonLaunch — path guard integration', () => {
  it('throws for a bunfs path', () => {
    expect(() => getDaemonLaunch('/$bunfs/root/agents')).toThrow(/bun virtual path/);
  });

  it('emits a warning (not a throw) for a worktree .js path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-wt-'));
    const wtBin = path.join(tmpDir, '.agents', 'worktrees', 'fix', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(wtBin), { recursive: true });
    fs.writeFileSync(wtBin, '');
    expect(() => getDaemonLaunch(wtBin)).not.toThrow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
