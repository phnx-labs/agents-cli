import { describe, test, expect } from 'bun:test';
import { parseUptime, parseVmStat, parseLinuxMemInfo } from './deviceHealth';
import { probeReachable } from '../vscode/deviceHealth.vscode';

const UPTIME_MACOS = ` 2:49  up 1 day, 15:25, 24 users, load averages: 7.33 6.84 6.96
`;

const UPTIME_LINUX = ` 14:30:00 up 3 days, 2:15, 1 user, load average: 0.52, 0.58, 0.59
`;

const VMSTAT_MACOS = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              440471.
Pages active:                           3685810.
Pages inactive:                         2821478.
Pages speculative:                       877701.
Pages throttled:                              0.
Pages wired down:                        476139.
Pages purgeable:                         150760.
"Translation faults":                1752021890.
Pages copy-on-write:                  171221652.
Pages zero filled:                   1526719754.
Pages reactivated:                       539299.
Pages purged:                           4885320.
File-backed pages:                      2524646.
Anonymous pages:                        4860343.
Pages stored in compressor:                   0.
Pages occupied by compressor:                 0.
Decompressions:                               0.
Compressions:                                 0.
Pageins:                               18384151.
Pageouts:                                     0.
Swapins:                                      0.
Swapouts:                                     0.
`;

const MEMINFO_LINUX = `MemTotal:         994548 kB
MemFree:           65228 kB
MemAvailable:     263724 kB
Buffers:           21396 kB
Cached:           304440 kB
SwapCached:        25260 kB
Active:           267424 kB
Inactive:         503720 kB
Active(anon):     110956 kB
Inactive(anon):   351176 kB
Active(file):      77400 kB
Inactive(file):   152544 kB
Unevictable:           0 kB
Mlocked:               0 kB
SwapTotal:       1048572 kB
SwapFree:         799312 kB
Dirty:               128 kB
Writeback:             0 kB
AnonPages:        462096 kB
Mapped:           132464 kB
Shmem:              1200 kB
KReclaimable:      51520 kB
Slab:              74756 kB
SReclaimable:      51520 kB
SUnreclaim:        23236 kB
KernelStack:        4512 kB
PageTables:         7568 kB
NFS_Unstable:          0 kB
Bounce:                0 kB
WritebackTmp:          0 kB
CommitLimit:     1540844 kB
Committed_AS:    1428024 kB
VmallocTotal:   34359738367 kB
VmallocUsed:        7424 kB
VmallocChunk:          0 kB
Percpu:             1584 kB
`;

describe('parseUptime', () => {
  test('parses macOS uptime', () => {
    expect(parseUptime(UPTIME_MACOS).loadAvg1).toBe(7.33);
  });

  test('parses Linux uptime', () => {
    expect(parseUptime(UPTIME_LINUX).loadAvg1).toBe(0.52);
  });

  test('returns undefined for missing load average', () => {
    expect(parseUptime('').loadAvg1).toBeUndefined();
  });
});

describe('parseVmStat', () => {
  test('parses macOS vm_stat', () => {
    const result = parseVmStat(VMSTAT_MACOS);
    expect(result.memPercent).toBeCloseTo(90.43, 2);
  });
});

describe('parseLinuxMemInfo', () => {
  test('parses Linux /proc/meminfo', () => {
    const result = parseLinuxMemInfo(MEMINFO_LINUX);
    expect(result.memPercent).toBeCloseTo(73.48, 2);
  });
});

describe('probeReachable', () => {
  test('treats this-mac as reachable', async () => {
    expect(await probeReachable('this-mac')).toBe(true);
  });
});
