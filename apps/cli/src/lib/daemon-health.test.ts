import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordSubsystemOk,
  recordSubsystemError,
  readSubsystemHealth,
  readAllSubsystemHealth,
} from './daemon-health.js';

// getDaemonDir() (state.ts) reads AGENTS_DAEMON_DIR fresh on every call, so no
// module reset is needed between tests — only the env var + a clean tmp dir.
describe('daemon-health', () => {
  let dir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-health-'));
    originalEnv = process.env.AGENTS_DAEMON_DIR;
    process.env.AGENTS_DAEMON_DIR = dir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENTS_DAEMON_DIR;
    else process.env.AGENTS_DAEMON_DIR = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports no record for a subsystem that has never checked in', () => {
    expect(readSubsystemHealth('secrets-broker')).toBeNull();
    expect(readAllSubsystemHealth()).toEqual([]);
  });

  it('records a success with no prior failures', () => {
    recordSubsystemOk('browser-ipc', '2026-01-01T00:00:00.000Z');
    expect(readSubsystemHealth('browser-ipc')).toEqual({
      subsystem: 'browser-ipc',
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      lastOkAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('accumulates consecutive failures and keeps the most recent error', () => {
    recordSubsystemError('secrets-broker', 'ENOENT: socket missing', '2026-01-01T00:00:00.000Z');
    recordSubsystemError('secrets-broker', 'ECONNREFUSED', '2026-01-01T00:01:00.000Z');
    const record = readSubsystemHealth('secrets-broker');
    expect(record?.consecutiveFailures).toBe(2);
    expect(record?.lastError).toBe('ECONNREFUSED');
    expect(record?.lastErrorAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('a success after failures clears the streak but keeps the failure history in lastError', () => {
    recordSubsystemError('secrets-broker', 'boom', '2026-01-01T00:00:00.000Z');
    recordSubsystemError('secrets-broker', 'boom again', '2026-01-01T00:01:00.000Z');
    recordSubsystemOk('secrets-broker', '2026-01-01T00:02:00.000Z');
    const record = readSubsystemHealth('secrets-broker');
    expect(record?.consecutiveFailures).toBe(0);
    expect(record?.lastOkAt).toBe('2026-01-01T00:02:00.000Z');
    // lastError is a record of what LAST happened, not cleared on recovery —
    // status/doctor distinguish "healthy now" via consecutiveFailures === 0.
    expect(record?.lastError).toBe('boom again');
  });

  it('tracks multiple subsystems independently and returns them sorted by name', () => {
    recordSubsystemOk('browser-ipc');
    recordSubsystemError('secrets-broker', 'unreachable');
    const all = readAllSubsystemHealth();
    expect(all.map((r) => r.subsystem)).toEqual(['browser-ipc', 'secrets-broker']);
    expect(all.find((r) => r.subsystem === 'secrets-broker')?.consecutiveFailures).toBe(1);
  });

  it('persists on disk under the daemon dir — a separate reader process sees the same record', () => {
    recordSubsystemError('browser-ipc', 'first failure');
    const healthPath = path.join(dir, 'health.json');
    expect(fs.existsSync(healthPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
    expect(onDisk['browser-ipc'].lastError).toBe('first failure');
  });

  it('a malformed health.json is treated as empty rather than throwing', () => {
    fs.writeFileSync(path.join(dir, 'health.json'), 'not json');
    expect(readAllSubsystemHealth()).toEqual([]);
    // And writing still recovers cleanly afterward.
    recordSubsystemOk('secrets-broker');
    expect(readSubsystemHealth('secrets-broker')?.consecutiveFailures).toBe(0);
  });
});
