/**
 * End-to-end audit-log tests. Drive the REAL CLI entry (via tsx) with a temp
 * HOME so the event log lands under the temp dir, then assert the structured
 * records. Covers the three things the audit backbone must guarantee:
 *   1. Every command fires a `command.start` with module + full command path.
 *   2. Every record carries who ran it (osUser) and from where (transport).
 *   3. SSH origin is attributed — "started on the host by a remote user".
 *   4. `agents events --module` filters the trail back out.
 *
 * No mocking — the same code path a real invocation takes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = (JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string }).version;

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-events-'));
  tempHomes.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION }),
  );
  return home;
}

function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, SHELL: '/bin/zsh', ...extraEnv },
    encoding: 'utf-8',
  });
}

/** Read every event record written under a temp HOME's log dir. */
function readEvents(home: string): Array<Record<string, unknown>> {
  const dir = path.join(home, '.agents', '.cache', 'logs');
  if (!fs.existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('events-') && n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').filter(Boolean)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

afterEach(() => {
  for (const h of tempHomes.splice(0)) {
    try {
      fs.rmSync(h, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('audit event log', () => {
  it('records a command.start with module, command path, and local-user attribution', () => {
    const home = makeTempHome();
    // `secrets list` exercises a two-level command path (module=secrets,
    // command="secrets list"). The preAction hook fires before the action, so
    // the audit record lands even if the action itself no-ops on this platform.
    // Clear SSH_CONNECTION so the local case is exercised even when the test
    // runner itself is on an SSH session.
    runCli(home, ['secrets', 'list'], { SSH_CONNECTION: '' });

    const events = readEvents(home);
    const start = events.find((e) => e.event === 'command.start' && e.command === 'secrets list');
    expect(start, `no command.start for "secrets list" in ${JSON.stringify(events.map((e) => e.command))}`).toBeTruthy();
    expect(start!.module).toBe('secrets');
    expect(typeof start!.osUser).toBe('string');
    expect((start!.osUser as string).length).toBeGreaterThan(0);
    expect(start!.transport).toBe('local');
    expect(start!.sshClientIp).toBeUndefined();
  });

  it('attributes an SSH origin to a remote user (SSH_CONNECTION → transport + client IP)', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'list'], {
      SSH_CONNECTION: '203.0.113.7 51828 10.0.0.3 22',
      SSH_TTY: '/dev/pts/4',
    });

    const events = readEvents(home);
    const start = events.find((e) => e.event === 'command.start');
    expect(start).toBeTruthy();
    expect(start!.transport).toBe('ssh');
    expect(start!.sshClientIp).toBe('203.0.113.7');
  });

  it('reads the trail back out and filters by module', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'list']);
    runCli(home, ['events', '--json']); // a second, different module

    const res = runCli(home, ['events', '--module', 'secrets', '--json']);
    expect(res.status).toBe(0);
    const records = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    expect(records.length).toBeGreaterThan(0);
    // Every returned record is from the secrets module, none from events.
    expect(records.every((r) => r.module === 'secrets')).toBe(true);
  });

  it('--command matches a command path by prefix', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'list']); // command path: "secrets list"

    // A coarse "secrets" must catch the "secrets list" record...
    const coarse = JSON.parse(runCli(home, ['events', '--command', 'secrets', '--json']).stdout) as Array<Record<string, unknown>>;
    expect(coarse.some((r) => r.command === 'secrets list')).toBe(true);
    // ...while a non-matching prefix returns nothing.
    const none = JSON.parse(runCli(home, ['events', '--command', 'teams', '--json']).stdout) as Array<Record<string, unknown>>;
    expect(none.length).toBe(0);
  });

  it('redacts a token-like positional arg before it hits the log', () => {
    const home = makeTempHome();
    // `secrets get <name>` no-ops (rc!=0) but the preAction hook still records
    // the invocation; the token-shaped positional must be masked, not stored.
    runCli(home, ['secrets', 'get', 'ghp_FAKETOKENVALUE123'], { SSH_CONNECTION: '' });

    const raw = fs.readFileSync(
      path.join(home, '.agents', '.cache', 'logs',
        `events-${new Date().toISOString().slice(0, 10)}.jsonl`),
      'utf-8',
    );
    expect(raw).not.toContain('ghp_FAKETOKENVALUE123');
    expect(raw).toContain('[REDACTED]');
  });

  it('--since with a sub-day window returns today\'s events (not just whole days)', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'list']);

    // Regression: query() used to skip today's file when startDate was later
    // than midnight, so a 2h window returned nothing on the day it was written.
    const res = runCli(home, ['events', '--since', '2h', '--json']);
    expect(res.status).toBe(0);
    const records = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    expect(records.length).toBeGreaterThan(0);
  });

  it('records command.end with a numeric durationMs', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'list']);

    const end = readEvents(home).find((e) => e.event === 'command.end' && e.command === 'secrets list');
    expect(end).toBeTruthy();
    expect(typeof end!.durationMs).toBe('number');
    expect(end!.durationMs as number).toBeGreaterThanOrEqual(0);
  });
});
