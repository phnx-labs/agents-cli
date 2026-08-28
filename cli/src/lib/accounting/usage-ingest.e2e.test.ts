import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real end-to-end of the `agents __usage-ingest` receiver verb: spawn the actual
// CLI with an isolated HOME, pipe a usage-sync payload to its stdin, and assert
// the rows landed in that HOME's real claude-usage.json. Exercises the index.ts
// pre-bootstrap interception + stdin read + newest-wins merge, no mocks.

function run(home: string, input: string) {
  return spawnSync('bun', ['src/index.ts', '__usage-ingest'], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
    cwd: process.cwd(),
    timeout: 60_000,
  });
}

function payload(usedPercent: number, capturedAt = '2026-08-28T12:00:00.000Z') {
  return JSON.stringify({
    v: 1,
    rows: {
      'claude:org=alpha': {
        capturedAt,
        windows: [
          { key: 'five_hour', label: 'Session (5h)', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 },
        ],
      },
    },
  });
}

describe('agents __usage-ingest (real CLI verb)', () => {
  let home = '';
  let cachePath = '';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ingest-e2e-'));
    cachePath = path.join(home, '.agents', '.cache', 'claude-usage.json');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('merges a piped payload into the isolated HOME cache and exits 0', () => {
    const res = run(home, payload(41));
    expect(res.status).toBe(0);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cache['claude:org=alpha'].windows[0].usedPercent).toBe(41);
  });

  it('exits 2 on a malformed payload and writes nothing', () => {
    const res = run(home, '{not json');
    expect(res.status).toBe(2);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('exits 0 on empty stdin (a quiet tick), writing nothing', () => {
    const res = run(home, '');
    expect(res.status).toBe(0);
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});
