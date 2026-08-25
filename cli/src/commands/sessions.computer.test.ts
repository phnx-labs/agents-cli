import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeUpdateCache, runAgents } from './sessions.test-fixture.js';

describe('sessions --computer alias', () => {
  it('forwards --limit through the real CLI route', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-computer-'));
    const cwd = path.join(tempHome, 'repo');
    const eventsPath = path.join(tempHome, 'computer-events.jsonl');
    fs.mkdirSync(cwd, { recursive: true });
    writeUpdateCache(tempHome);
    fs.writeFileSync(eventsPath, [
      { ts: '2026-08-08T09:00:00.000Z', event: 'computer.action', pid: 10, invocationId: 'one', command: 'click', hostname: 'zion' },
      { ts: '2026-08-08T09:01:00.000Z', event: 'computer.action', pid: 11, invocationId: 'two', command: 'screenshot', hostname: 'zion' },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    try {
      const result = runAgents(
        ['sessions', '--computer', '--limit', '1', '--no-interactive'],
        cwd,
        tempHome,
        { AGENTS_EVENTS_PATH: eventsPath },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('screenshot 1');
      expect(result.stdout).not.toContain('click 1');
      expect(result.stdout).toContain('… (1 more; --limit 2 or --json to see all');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it.each([
    ['--device', 'all'],
    ['--device', 'fleet'],
    ['--devices', 'all'],
    ['--devices', 'fleet'],
  ])('%s %s keeps local rows and stdout valid JSON', (flag, sentinel) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-computer-fleet-'));
    const cwd = path.join(tempHome, 'repo');
    const eventsPath = path.join(tempHome, 'computer-events.jsonl');
    fs.mkdirSync(cwd, { recursive: true });
    writeUpdateCache(tempHome);
    fs.writeFileSync(eventsPath, JSON.stringify({
      ts: '2026-08-08T09:01:00.000Z',
      event: 'computer.action',
      pid: 11,
      invocationId: 'local-run',
      command: 'screenshot',
      hostname: 'zion',
    }) + '\n');
    try {
      const result = runAgents(
        ['sessions', '--computer', flag, sentinel, '--json'],
        cwd,
        tempHome,
        { AGENTS_EVENTS_PATH: eventsPath },
      );
      expect(result.status, result.stderr).toBe(0);
      const rows = JSON.parse(result.stdout) as Array<{ invocationId?: string }>;
      expect(rows.map((row) => row.invocationId)).toEqual(['local-run']);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
