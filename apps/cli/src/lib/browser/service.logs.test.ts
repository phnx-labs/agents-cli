import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';
import * as profiles from './profiles.js';

const TEST_HOME = path.join(tmpdir(), 'agents-cli-browser-logs-test');
const TEST_AGENTS_DIR = path.join(TEST_HOME, '.agents');
const TEST_LOG_DIR = path.join(TEST_HOME, 'logs');

vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getAgentsDir').mockReturnValue(TEST_AGENTS_DIR);

// Spy on the single profile lookup we want to override instead of mocking
// the whole module — the other profiles.js exports (getProfileRuntimeDir,
// listProfiles, …) keep their real implementations and service.js loads
// without missing-export errors. This avoids needing vi.hoisted /
// vi.importActual, neither of which Bun's native test runner supports.
vi.spyOn(profiles, 'getProfile').mockImplementation(async (name: string) => {
  if (name === 'rush-with-logs') {
    return {
      name,
      browser: 'chrome',
      endpoints: ['cdp://localhost:9222'],
      logDir: TEST_LOG_DIR,
    };
  }
  if (name === 'rush-no-logs') {
    return {
      name,
      browser: 'chrome',
      endpoints: ['cdp://localhost:9223'],
    };
  }
  return null;
});

const {
  BrowserService,
  parseSinceUntil,
  readNewestMatchingFile,
  readNewestMatchingRemoteFileCommand,
} = await import('./service.js');

function reset(): void {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
  fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
}

function writeJsonl(filename: string, entries: Array<Record<string, unknown>>): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(TEST_LOG_DIR, filename), lines);
}

/**
 * Inject a fake task into a BrowserService instance so getAppLogs can resolve
 * it without spinning up CDP. getAppLogs only reads task.profile from the
 * resolved task; conn fields don't matter for this path.
 */
function injectTask(service: any, profileName: string, taskName: string): void {
  const fakeConn = {
    cdp: {},
    port: 0,
    pid: 0,
    tasks: new Map<string, unknown>(),
    sessionCache: new Map<string, string>(),
  };
  fakeConn.tasks.set(taskName, {
    id: 'tid',
    name: taskName,
    profile: profileName,
    tabs: {},
    createdAt: Date.now(),
    pid: 0,
  });
  service.connections.set(profileName, fakeConn);
}

beforeEach(reset);
afterEach(() => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('parseSinceUntil', () => {
  it('parses relative seconds/minutes/hours/days', () => {
    const now = Date.now();
    const d = parseSinceUntil('5m');
    expect(Math.abs(d.getTime() - (now - 5 * 60_000))).toBeLessThan(1000);
  });

  it('parses ISO-8601 timestamps', () => {
    const d = parseSinceUntil('2026-05-14T12:00:00Z');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(4);
  });

  it('throws on garbage', () => {
    expect(() => parseSinceUntil('definitely-not-a-time')).toThrow();
  });
});

describe('readNewestMatchingFile', () => {
  it('returns empty string when directory has no matches', () => {
    expect(readNewestMatchingFile(TEST_LOG_DIR, 'rush-app-', 10)).toBe('');
  });

  it('picks the newest file by mtime and tails N lines', async () => {
    writeJsonl('rush-app-2026-05-13.jsonl', [{ n: 1 }, { n: 2 }]);
    // Touch a newer file with later mtime
    await new Promise((r) => setTimeout(r, 10));
    writeJsonl('rush-app-2026-05-14.jsonl', [{ n: 3 }, { n: 4 }, { n: 5 }]);
    const out = readNewestMatchingFile(TEST_LOG_DIR, 'rush-app-', 2);
    const parsed = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed).toEqual([{ n: 4 }, { n: 5 }]);
  });
});

describe('readNewestMatchingRemoteFileCommand', () => {
  it('shell-quotes the remote log directory before globbing', () => {
    const cmd = readNewestMatchingRemoteFileCommand('/tmp/log dir', 'rush-app-', 25);
    expect(cmd).toContain("'/tmp/log dir'/rush-app-*.jsonl");
    expect(cmd).toContain('tail -n 25 "$latest"');
  });
});

describe('BrowserService.getAppLogs', () => {
  const APP_DATE = '2020-01-01';
  beforeEach(() => {
    // Use a deeply past date so `--since '1m'` reliably excludes everything.
    writeJsonl(`rush-app-${APP_DATE}.jsonl`, [
      { timestamp: `${APP_DATE}T12:00:00Z`, level: 'info', message: 'ipc_call', ipc: 'auth:start' },
      { timestamp: `${APP_DATE}T12:01:00Z`, level: 'error', message: 'crash', err: 'boom' },
      { timestamp: `${APP_DATE}T12:02:00Z`, level: 'info', message: 'agent_ready' },
    ]);
    writeJsonl(`rush-cli-${APP_DATE}.jsonl`, [
      { timestamp: `${APP_DATE}T11:59:30Z`, level: 'info', message: 'agent_start', pid: 999 },
      { timestamp: `${APP_DATE}T12:00:30Z`, level: 'info', message: 'ipc_call', ipc: 'rpc:foo' },
      { timestamp: `${APP_DATE}T12:03:00Z`, level: 'warn', message: 'drift' },
    ]);
  });

  it('throws when profile has no logDir', async () => {
    const service = new BrowserService();
    injectTask(service, 'rush-no-logs', 't1');
    await expect(service.getAppLogs('t1', {})).rejects.toThrow(/logDir/);
  });

  it('unions both sources sorted by timestamp', async () => {
    const service = new BrowserService();
    injectTask(service, 'rush-with-logs', 't1');
    const entries = await service.getAppLogs('t1', {});
    expect(entries).toHaveLength(6);
    expect(entries[0].message).toBe('agent_start');
    expect(entries[entries.length - 1].message).toBe('drift');
  });

  it('--source rush-cli scopes to one', async () => {
    const service = new BrowserService();
    injectTask(service, 'rush-with-logs', 't1');
    const entries = await service.getAppLogs('t1', { source: 'rush-cli' });
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.message)).toEqual(['agent_start', 'ipc_call', 'drift']);
    expect(entries.find((e) => e.message === 'ipc_call').ipc).toBe('rpc:foo');
  });

  it('--level error filter works', async () => {
    const service = new BrowserService();
    injectTask(service, 'rush-with-logs', 't1');
    const entries = await service.getAppLogs('t1', { level: 'error' });
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('crash');
  });

  it('--message agent_start filter works', async () => {
    const service = new BrowserService();
    injectTask(service, 'rush-with-logs', 't1');
    const entries = await service.getAppLogs('t1', { message: 'agent_start' });
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(999);
  });

  it('--since "1m" parses relative duration (no logs from 2026-05-14 fall in last minute)', async () => {
    const service = new BrowserService();
    injectTask(service, 'rush-with-logs', 't1');
    const entries = await service.getAppLogs('t1', { since: '1m' });
    expect(entries).toEqual([]);
  });

  it('--lines 2 tail-trims', async () => {
    const service = new BrowserService();
    injectTask(service, 'rush-with-logs', 't1');
    const entries = await service.getAppLogs('t1', { lines: 2 });
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('agent_ready');
    expect(entries[1].message).toBe('drift');
  });
});
