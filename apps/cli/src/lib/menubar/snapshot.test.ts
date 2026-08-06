import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readLastWatchdogTick } from './snapshot.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('menubar snapshot', () => {
  it('reads the daemon-owned watchdog result without running a watchdog tick', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-'));
    dirs.push(dir);
    const tick = {
      didNudge: true,
      counts: { total: 2, stalled: 1, nudged: 1, unaddressable: 0, skipped: 1 },
      outcomes: [],
    };
    fs.writeFileSync(path.join(dir, 'last-tick.json'), JSON.stringify(tick));

    expect(readLastWatchdogTick(dir)).toEqual(tick);
  });

  it('returns null when the daemon has not published a watchdog result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-'));
    dirs.push(dir);
    expect(readLastWatchdogTick(dir)).toBeNull();
  });
});
