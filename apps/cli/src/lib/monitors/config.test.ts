import { afterEach, describe, expect, it } from 'vitest';
import {
  validateMonitor,
  parseInterval,
  monitorRunsOnThisDevice,
  writeMonitor,
  readMonitor,
  deleteMonitor,
  listMonitors,
  type MonitorConfig,
} from './config.js';
import { machineId } from '../machine-id.js';

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
