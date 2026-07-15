import { describe, it, expect } from 'vitest';
import {
  parseUptime,
  parseVmStat,
  parseLinuxMemInfo,
  parseNcpu,
  parseProbeOutput,
  headroom,
  fmtBytes,
  fleetCapacity,
  type DeviceStats,
} from './health.js';

describe('parseUptime', () => {
  it('reads the macOS "load averages:" form', () => {
    expect(parseUptime('12:34  up 3 days, 1:02, 4 users, load averages: 1.83 2.01 1.95').loadAvg1).toBe(1.83);
  });
  it('reads the linux "load average:" (comma-separated) form', () => {
    expect(parseUptime(' 19:30:01 up 40 days,  2:14,  0 users,  load average: 0.20, 0.34, 0.31').loadAvg1).toBe(0.2);
  });
  it('handles comma as the decimal separator (some locales)', () => {
    expect(parseUptime('load average: 0,68, 0,50, 0,40').loadAvg1).toBe(0.68);
  });
  it('returns nothing when there is no load line', () => {
    expect(parseUptime('garbage')).toEqual({});
  });
});

describe('parseLinuxMemInfo', () => {
  it('computes used% and total/free bytes from MemTotal/MemAvailable', () => {
    const out = 'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:   14417920 kB\n';
    const m = parseLinuxMemInfo(out);
    expect(Math.round(m.memPercent!)).toBe(12); // (16384000 - 14417920) / 16384000
    expect(m.memTotalBytes).toBe(16384000 * 1024);
    expect(m.memFreeBytes).toBe(14417920 * 1024);
  });
  it('returns nothing without MemAvailable', () => {
    expect(parseLinuxMemInfo('MemTotal: 16384000 kB')).toEqual({});
  });
});

describe('parseVmStat', () => {
  it('computes used% from active+wired+compressed vs free', () => {
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                          100000.',
      'Pages active:                        250000.',
      'Pages wired down:                    100000.',
      'Pages occupied by compressor:         50000.',
    ].join('\n');
    const m = parseVmStat(out);
    // used = 400000 pages, total = 500000 pages -> 80%
    expect(Math.round(m.memPercent!)).toBe(80);
    expect(m.memTotalBytes).toBe(500000 * 16384); // total pages * page size
    expect(m.memFreeBytes).toBe(100000 * 16384);
  });
  it('returns nothing when a required page class is missing', () => {
    expect(parseVmStat('Pages free: 100.')).toEqual({});
  });
});

describe('parseNcpu', () => {
  it('reads a bare integer (nproc / hw.ncpu)', () => {
    expect(parseNcpu('16\n').ncpu).toBe(16);
  });
  it('rejects non-positive / garbage', () => {
    expect(parseNcpu('0')).toEqual({});
    expect(parseNcpu('nope')).toEqual({});
  });
});

describe('parseProbeOutput', () => {
  it('assembles load, ncpu, normalized load%, and mem% (linux)', () => {
    const stdout = [
      'load average: 4.00, 3.0, 2.0',
      '---AGSTAT---',
      'MemTotal:       10000 kB\nMemAvailable:    2000 kB',
      '---AGSTAT---',
      '16',
    ].join('\n');
    const s = parseProbeOutput('box', stdout, 111);
    expect(s.loadAvg1).toBe(4);
    expect(s.ncpu).toBe(16);
    expect(s.loadPercent).toBeCloseTo(25); // 4/16
    expect(Math.round(s.memPercent!)).toBe(80);
    expect(s.reachable).toBe(true);
    expect(s.fetchedAt).toBe(111);
  });
  it('leaves loadPercent undefined when ncpu is unknown', () => {
    const stdout = ['load average: 2.0, 1, 1', '---AGSTAT---', 'MemTotal: 100 kB\nMemAvailable: 50 kB', '---AGSTAT---', 'oops'].join('\n');
    expect(parseProbeOutput('box', stdout, 0).loadPercent).toBeUndefined();
  });
});

describe('headroom', () => {
  const at = (loadPercent?: number, memPercent?: number) =>
    headroom({ host: 'h', reachable: true, loadPercent, memPercent, fetchedAt: 0 });
  it('buckets by the worst of load and mem', () => {
    expect(at(5, 5)).toBe('idle');
    expect(at(5, 30)).toBe('light');
    expect(at(50, 5)).toBe('busy');
    expect(at(5, 90)).toBe('loaded');
  });
  it('is unknown when unreachable or statless', () => {
    expect(headroom(undefined)).toBe('unknown');
    expect(headroom({ host: 'h', reachable: false, fetchedAt: 0 })).toBe('unknown');
    expect(at(undefined, undefined)).toBe('unknown');
  });
});

describe('fmtBytes', () => {
  it('formats binary units with ≤1 decimal', () => {
    expect(fmtBytes(0)).toBe('0B');
    expect(fmtBytes(512 * 1024)).toBe('512K');
    expect(fmtBytes(64 * 1024 ** 3)).toBe('64G');
    expect(fmtBytes(1.5 * 1024 ** 4)).toBe('1.5T');
  });
  it('renders a dash for missing/invalid', () => {
    expect(fmtBytes(undefined)).toBe('—');
    expect(fmtBytes(-1)).toBe('—');
  });
});

describe('fleetCapacity', () => {
  it('sums cores and memory across reachable devices only', () => {
    const list: DeviceStats[] = [
      { host: 'a', reachable: true, ncpu: 16, memTotalBytes: 64e9, memFreeBytes: 40e9, fetchedAt: 0 },
      { host: 'b', reachable: true, ncpu: 20, memTotalBytes: 128e9, memFreeBytes: 100e9, fetchedAt: 0 },
      { host: 'c', reachable: false, ncpu: 8, memTotalBytes: 32e9, memFreeBytes: 8e9, fetchedAt: 0 }, // excluded
    ];
    const cap = fleetCapacity(list);
    expect(cap.reachable).toBe(2);
    expect(cap.cores).toBe(36);
    expect(cap.memTotalBytes).toBe(192e9);
    expect(cap.memFreeBytes).toBe(140e9);
  });
});
