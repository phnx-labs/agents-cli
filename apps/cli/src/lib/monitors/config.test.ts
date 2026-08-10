import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateMonitor,
  parseInterval,
  monitorRunsOnThisDevice,
  writeMonitor,
  readMonitor,
  deleteMonitor,
  listMonitors,
  setMonitorEnabled,
  getMonitorPath,
  type MonitorConfig,
} from './config.js';
import { machineId } from '../machine-id.js';
import { getMonitorsDir, getSystemMonitorsDir } from '../state.js';

/** Minimal valid monitor: poll a command, on-change, notify. */
function base(partial: Partial<MonitorConfig> = {}): Partial<MonitorConfig> {
  return {
    name: 'm',
    enabled: true,
    source: { type: 'poll', command: 'echo hi', interval: '30s' },
    condition: { mode: 'on-change' },
    action: { type: 'notify', notifyChannel: 'telegram' },
    ...partial,
  };
}

describe('validateMonitor — source/action requirements', () => {
  it('accepts a minimal valid monitor', () => {
    expect(validateMonitor(base())).toEqual([]);
  });

  it('rejects a monitor with no source', () => {
    const errors = validateMonitor(base({ source: undefined }));
    expect(errors.some((e) => /a source is required/.test(e))).toBe(true);
  });

  it('rejects a monitor with two sources (conflicting fields)', () => {
    const errors = validateMonitor(
      base({ source: { type: 'poll', command: 'echo hi', interval: '30s', url: 'https://x.test' } }),
    );
    expect(errors.some((e) => /conflicting fields/.test(e))).toBe(true);
  });

  it('rejects a monitor with no action', () => {
    const errors = validateMonitor(base({ action: undefined }));
    expect(errors.some((e) => /an action is required/.test(e))).toBe(true);
  });

  it('rejects a monitor with two actions (conflicting fields)', () => {
    const errors = validateMonitor(
      base({ action: { type: 'run', agent: 'claude', prompt: 'x', routine: 'other' } }),
    );
    expect(errors.some((e) => /conflicting fields/.test(e))).toBe(true);
  });

  it('rejects match-mode without condition.match', () => {
    const errors = validateMonitor(base({ condition: { mode: 'match' } }));
    expect(errors.some((e) => /requires condition\.match/.test(e))).toBe(true);
  });

  it('accepts match-mode with a match regex', () => {
    expect(validateMonitor(base({ condition: { mode: 'match', match: 'fail' } }))).toEqual([]);
  });

  it('rejects an invalid match regex', () => {
    const errors = validateMonitor(base({ condition: { mode: 'match', match: '([' } }));
    expect(errors.some((e) => /not a valid regular expression/.test(e))).toBe(true);
  });

  it('rejects a poll source with no interval', () => {
    const errors = validateMonitor(base({ source: { type: 'poll', command: 'echo hi' } }));
    expect(errors.some((e) => /requires source\.interval/.test(e))).toBe(true);
  });

  it('rejects poll-http without a url (wrong field for the type)', () => {
    const errors = validateMonitor(base({ source: { type: 'poll-http', command: 'echo', interval: '1m' } }));
    expect(errors.some((e) => /requires source\.url|conflicting fields/.test(e))).toBe(true);
  });

  it('rejects a run action without a prompt', () => {
    const errors = validateMonitor(base({ action: { type: 'run', agent: 'claude' } }));
    expect(errors.some((e) => /requires action\.prompt/.test(e))).toBe(true);
  });

  it('rejects a run action with an unknown agent', () => {
    const errors = validateMonitor(base({ action: { type: 'run', agent: 'nope' as never, prompt: 'x' } }));
    expect(errors.some((e) => /action\.agent must be one of/.test(e))).toBe(true);
  });

  it('rejects device + devices together', () => {
    const errors = validateMonitor(base({ device: 'a', devices: ['b'] }));
    expect(errors.some((e) => /mutually exclusive/.test(e))).toBe(true);
  });

  it('rejects a malformed rateLimit', () => {
    const errors = validateMonitor(base({ rateLimit: { max: 0, per: 'nope' } }));
    expect(errors.some((e) => /rateLimit\.max/.test(e))).toBe(true);
    expect(errors.some((e) => /rateLimit\.per/.test(e))).toBe(true);
  });
});

describe('parseInterval', () => {
  it('parses seconds', () => {
    expect(parseInterval('30s')).toBe(30_000);
  });
  it('parses compound durations', () => {
    expect(parseInterval('1h30m')).toBe((60 + 30) * 60 * 1000);
  });
  it('parses hours and days', () => {
    expect(parseInterval('8h')).toBe(8 * 60 * 60 * 1000);
    expect(parseInterval('1d')).toBe(24 * 60 * 60 * 1000);
  });
  it('rejects garbage and zero', () => {
    expect(parseInterval('nope')).toBeNull();
    expect(parseInterval('0s')).toBeNull();
    expect(parseInterval('')).toBeNull();
  });
});

describe('monitorRunsOnThisDevice — owner semantics', () => {
  it('runs anywhere when unrestricted', () => {
    expect(monitorRunsOnThisDevice({})).toBe(true);
  });
  it('runs only on the owner device', () => {
    expect(monitorRunsOnThisDevice({ device: machineId() })).toBe(true);
    expect(monitorRunsOnThisDevice({ device: 'some-other-box-xyz' })).toBe(false);
  });
  it('honors an allowlist', () => {
    expect(monitorRunsOnThisDevice({ devices: [machineId(), 'other'] })).toBe(true);
    expect(monitorRunsOnThisDevice({ devices: ['other-a', 'other-b'] })).toBe(false);
  });
});

describe('monitor CRUD round-trip', () => {
  const name = `test-monitor-${process.pid}-${Date.now()}`;

  afterEach(() => {
    deleteMonitor(name);
  });

  it('writes, reads back, lists, and deletes a monitor', () => {
    const config = base({ name }) as MonitorConfig;
    writeMonitor(config);

    const read = readMonitor(name);
    expect(read).not.toBeNull();
    expect(read!.name).toBe(name);
    expect(read!.source.type).toBe('poll');
    expect(read!.condition.mode).toBe('on-change');
    expect(read!.action.type).toBe('notify');

    expect(listMonitors().some((m) => m.name === name)).toBe(true);

    expect(deleteMonitor(name)).toBe(true);
    expect(readMonitor(name)).toBeNull();
  });
});

describe('system-layer monitors (built-ins from ~/.agents/.system/monitors/)', () => {
  let userDir: string;
  let sysDir: string;
  const prevUser = process.env.AGENTS_MONITORS_DIR;
  const prevSys = process.env.AGENTS_SYSTEM_MONITORS_DIR;

  /**
   * A full valid monitor YAML: a poll source + on-change condition + a notify
   * action on the given channel. `header` prepends name/enabled lines per test.
   */
  function monitorYaml(header: string, notifyChannel = 'telegram'): string {
    return (
      header +
      'source:\n' +
      '  type: poll\n' +
      '  command: echo hi\n' +
      '  interval: 30s\n' +
      'condition:\n' +
      '  mode: on-change\n' +
      'action:\n' +
      '  type: notify\n' +
      `  notifyChannel: ${notifyChannel}\n`
    );
  }

  beforeEach(() => {
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-user-'));
    sysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-sys-'));
    process.env.AGENTS_MONITORS_DIR = userDir;
    process.env.AGENTS_SYSTEM_MONITORS_DIR = sysDir;
  });

  afterEach(() => {
    if (prevUser === undefined) delete process.env.AGENTS_MONITORS_DIR;
    else process.env.AGENTS_MONITORS_DIR = prevUser;
    if (prevSys === undefined) delete process.env.AGENTS_SYSTEM_MONITORS_DIR;
    else process.env.AGENTS_SYSTEM_MONITORS_DIR = prevSys;
    fs.rmSync(userDir, { recursive: true, force: true });
    fs.rmSync(sysDir, { recursive: true, force: true });
  });

  it('(a) discovers a monitor placed in the system dir', () => {
    fs.writeFileSync(path.join(sysDir, 'built-in.yml'), monitorYaml('name: built-in\nenabled: true\n'));
    const found = listMonitors().find((m) => m.name === 'built-in');
    expect(found).toBeDefined();
    expect(found!.enabled).toBe(true);
    expect(readMonitor('built-in')?.source.type).toBe('poll');
    // getMonitorPath is user-layer only (its caller writes), so a system-only
    // built-in returns null — `edit` materializes a user copy rather than
    // opening the pull-only mirror.
    expect(getMonitorPath('built-in')).toBeNull();
  });

  it('(b) a user monitor of the same name shadows the system one', () => {
    fs.writeFileSync(path.join(sysDir, 'dupe.yml'), monitorYaml('name: dupe\nenabled: true\n', 'telegram'));
    fs.writeFileSync(path.join(userDir, 'dupe.yml'), monitorYaml('name: dupe\nenabled: true\n', 'desktop'));

    // Exactly one entry for the name, and it is the user copy.
    const matches = listMonitors().filter((m) => m.name === 'dupe');
    expect(matches.length).toBe(1);
    expect(matches[0].action.notifyChannel).toBe('desktop');
    expect(readMonitor('dupe')?.action.notifyChannel).toBe('desktop');
    // getMonitorPath returns the user copy, not the system one.
    expect(getMonitorPath('dupe')).toBe(path.join(userDir, 'dupe.yml'));
  });

  it('(c) a system built-in with no enabled: field is opt-in (disabled until toggled)', () => {
    fs.writeFileSync(path.join(sysDir, 'optin.yml'), monitorYaml('name: optin\n'));

    // Read straight from the system layer — opt-in, so disabled.
    expect(readMonitor('optin')?.enabled).toBe(false);
    expect(listMonitors().find((m) => m.name === 'optin')?.enabled).toBe(false);

    // A user monitor with no enabled: field, by contrast, defaults to enabled.
    fs.writeFileSync(path.join(userDir, 'userdefault.yml'), monitorYaml('name: userdefault\n'));
    expect(readMonitor('userdefault')?.enabled).toBe(true);
  });

  it('(d) enabling a system built-in writes into the USER dir, never the system dir', () => {
    fs.writeFileSync(path.join(sysDir, 'optin.yml'), monitorYaml('name: optin\n'));
    expect(readMonitor('optin')?.enabled).toBe(false);

    setMonitorEnabled('optin', true);

    // The user dir now holds the materialized copy; the system mirror is untouched.
    expect(fs.existsSync(path.join(userDir, 'optin.yml'))).toBe(true);
    const sysBody = fs.readFileSync(path.join(sysDir, 'optin.yml'), 'utf-8');
    expect(sysBody).not.toContain('enabled: true');
    // The user copy now wins and reads enabled.
    expect(readMonitor('optin')?.enabled).toBe(true);
    expect(getMonitorPath('optin')).toBe(path.join(userDir, 'optin.yml'));

    // Editing (write) also lands in the user dir only.
    const cfg = readMonitor('optin')!;
    cfg.action = { type: 'notify', notifyChannel: 'desktop' };
    writeMonitor(cfg);
    expect(getMonitorsDir()).toBe(userDir);
    expect(getSystemMonitorsDir()).toBe(sysDir);
    expect(readMonitor('optin')?.action.notifyChannel).toBe('desktop');
    // The system file's action was not rewritten.
    expect(fs.readFileSync(path.join(sysDir, 'optin.yml'), 'utf-8')).toContain('notifyChannel: telegram');
  });
});
