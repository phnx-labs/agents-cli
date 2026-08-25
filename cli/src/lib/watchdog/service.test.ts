import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runWatchdogPass } from './service.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('watchdog service', () => {
  it('runs the daemon/CLI shared pass and publishes the menu snapshot source', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-service-'));
    dirs.push(stateDir);
    const result = await runWatchdogPass({
      nudge: true,
      sessions: [],
      stateDir,
      mailboxGc: false,
    });

    expect(result.didNudge).toBe(true);
    expect(result.counts.total).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'last-tick.json'), 'utf-8'))).toEqual(result);
  });
});
