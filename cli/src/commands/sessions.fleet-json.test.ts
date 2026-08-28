import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeUpdateCache, writeClaudeSession, runAgents } from './sessions.test-fixture.js';

/**
 * PHNX-2673: a HISTORICAL `agents sessions --device all/fleet --json` query must
 * fan out to the fleet and merge peer rows — not silently return local rows only.
 *
 * The transport boundary (and only that) is stubbed: a fake `ssh` on the run's
 * PATH answers every dial with the peer's `sessions --json` array, exactly as a
 * real remote CLI would over SSH. Everything above it — the sentinel routing in
 * `runSessions`, `gatherRemoteList`'s registry discovery, the merge, and the
 * `--json` serializer — is the real code path.
 */

const SELF = 'fleet-json-self';
const PEER = 'fleet-json-peer';
const PEER_SESSION_ID = '11111111-2222-4333-8444-555555555555';

/** Register `PEER` as an automatic (dialable, non-self) session peer so the
 * `--device all` sweep discovers it through `loadDevices()`. */
function registerPeer(devicesDir: string): void {
  fs.mkdirSync(devicesDir, { recursive: true });
  const now = new Date().toISOString();
  const reg = {
    [PEER]: {
      name: PEER,
      platform: 'linux',
      shell: 'posix',
      user: 'someone',
      address: { via: 'tailscale', dnsName: `${PEER}.example.ts.net` },
      auth: { method: 'key' },
      createdAt: now,
      updatedAt: now,
    },
  };
  fs.writeFileSync(path.join(devicesDir, 'registry.json'), JSON.stringify(reg));
}

/** A fake `ssh` that ignores its args and prints the peer's session array, the
 * shape a real `agents sessions --json` peer would return over the wire. */
function installFakeSsh(home: string): void {
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const sshPath = path.join(binDir, 'ssh');
  const rows = JSON.stringify([
    {
      id: PEER_SESSION_ID,
      shortId: '11111111',
      agent: 'claude',
      timestamp: '2026-08-20T10:00:00.000Z',
      lastActivity: '2026-08-20T10:00:00.000Z',
      project: 'peer-project',
      version: '2.1.110',
    },
  ]);
  fs.writeFileSync(sshPath, `#!/bin/sh\ncat <<'JSON'\n${rows}\nJSON\n`);
  fs.chmodSync(sshPath, 0o755);
}

function env(home: string): Record<string, string> {
  return {
    AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
    AGENTS_SYNC_MACHINE_ID: SELF,
  };
}

describe.skipIf(process.platform === 'win32')('sessions --device all/fleet --json fleet fan-out (PHNX-2673)', () => {
  it.each([
    ['--device', 'all'],
    ['--device', 'fleet'],
    ['--devices', 'all'],
    ['--devices', 'fleet'],
  ])('%s %s merges a peer\'s historical rows into the local JSON listing', (flag, sentinel) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-fleet-json-'));
    const cwd = path.join(tempHome, 'repo');
    try {
      writeUpdateCache(tempHome);
      const localId = '99999999-8888-4777-8666-555555555555';
      writeClaudeSession(
        tempHome,
        cwd.replace(/[/.]/g, '-'),
        localId,
        cwd,
        'local hook work',
        '2026-08-20T09:00:00.000Z',
      );
      registerPeer(path.join(tempHome, '.agents', '.history', 'devices'));
      installFakeSsh(tempHome);

      // BEFORE-equivalent control: the default (no --device) stays local-only.
      const localOnly = runAgents(['sessions', '--json', '--no-interactive'], cwd, tempHome, env(tempHome));
      expect(localOnly.status, localOnly.stderr).toBe(0);
      const localRows = JSON.parse(localOnly.stdout) as Array<{ id: string }>;
      const localIds = localRows.map((r) => r.id);
      expect(localIds).toContain(localId);
      expect(localIds).not.toContain(PEER_SESSION_ID);

      // AFTER: the fleet sentinel fans out and the peer's row is merged in.
      const fleet = runAgents(['sessions', flag, sentinel, '--json', '--no-interactive'], cwd, tempHome, env(tempHome));
      expect(fleet.status, fleet.stderr).toBe(0);
      const fleetRows = JSON.parse(fleet.stdout) as Array<{ id: string; machine?: string }>;
      const fleetIds = fleetRows.map((r) => r.id);
      expect(fleetIds).toContain(localId);
      expect(fleetIds).toContain(PEER_SESSION_ID);
      // The merged peer row is tagged with the machine it was dialed on.
      expect(fleetRows.find((r) => r.id === PEER_SESSION_ID)?.machine).toBe(PEER);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('--local pins the fleet sentinel to this machine (no fan-out)', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-fleet-json-local-'));
    const cwd = path.join(tempHome, 'repo');
    try {
      writeUpdateCache(tempHome);
      const localId = '77777777-6666-4555-8444-333333333333';
      writeClaudeSession(
        tempHome,
        cwd.replace(/[/.]/g, '-'),
        localId,
        cwd,
        'local only work',
        '2026-08-20T09:00:00.000Z',
      );
      registerPeer(path.join(tempHome, '.agents', '.history', 'devices'));
      installFakeSsh(tempHome);

      const result = runAgents(
        ['sessions', '--device', 'all', '--local', '--json', '--no-interactive'],
        cwd,
        tempHome,
        env(tempHome),
      );
      expect(result.status, result.stderr).toBe(0);
      const ids = (JSON.parse(result.stdout) as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(localId);
      expect(ids).not.toContain(PEER_SESSION_ID);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
