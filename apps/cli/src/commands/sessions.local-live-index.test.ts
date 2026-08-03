/**
 * RUSH-2118 follow-up (prix-cloud review on PR #1827): the `--local` help
 * text promises "this machine only" for BOTH the default listing and
 * `--active` (sessions.ts `--local` option help). The `--active` path was
 * fixed to never dial a remote-host teammate under `--local`, but the
 * DEFAULT (non `--active`) listing enriches every row via `maybeLiveIndex()`,
 * which called the local-only `getActiveSessions()` with no `localOnly`
 * threaded through — so a bare `agents sessions --local` still fired an ssh
 * round-trip per remote-host teammate.
 *
 * HOME is pinned to a temp dir BEFORE importing anything that resolves
 * `~/.agents` (teams/agents.ts, sessions.ts), so AgentManager's default
 * construction (no explicit baseDir — `maybeLiveIndex` has no way to inject
 * one) reads/writes under our temp fixture instead of the real fleet. Only
 * the ssh network boundary is stubbed; AgentManager/AgentProcess run for real.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-local-live-index-home-'));
const originalHome = process.env.HOME;
process.env.HOME = fakeHome;
fs.mkdirSync(path.join(fakeHome, '.agents'), { recursive: true });

const { sshExecMock, sshExecRawMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn(),
  sshExecRawMock: vi.fn(),
}));

// Keep everything else in ssh-exec.js real; only the two functions that
// actually reach the network are stubbed.
vi.mock('../lib/ssh-exec.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/ssh-exec.js')>('../lib/ssh-exec.js');
  return { ...actual, sshExec: sshExecMock, sshExecRaw: sshExecRawMock };
});

const { maybeLiveIndex } = await import('./sessions.js');
const { AgentProcess, AgentStatus } = await import('../lib/teams/agents.js');

afterEach(() => {
  sshExecMock.mockReset();
  sshExecRawMock.mockReset();
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

/** A remote-host teammate (dispatched via `agents teams add --device`): no
 * local pid, lifecycle lives entirely on the host via hostName/hostTarget. */
async function makeRemoteTeammate(id: string): Promise<void> {
  const agent = new AgentProcess(
    id, 'dist-team', 'claude', 'do a thing',
    null, 'plan', null, AgentStatus.RUNNING, new Date(), null,
  );
  agent.hostName = 'fake-device';
  agent.hostTarget = 'fake-device.tail1a85a1.ts.net';
  agent.repoPath = '/home/fake/repo';
  agent.remotePid = 4242;
  // A real remote teammate captures this off its first stream event; without
  // it the row has no id to key `indexActiveBySessionId` on and gets dropped
  // — set it directly so the row survives into the live index for asserting on.
  agent.remoteSessionId = `${id}-ffffffff-ffff-ffff-ffff-ffffffffffff`;
  agent.remoteLog = '$HOME/.agents/.cache/hosts/aaaaaaaa.log';
  agent.remoteExit = '$HOME/.agents/.cache/hosts/aaaaaaaa.exit';
  agent.remoteLogOffset = 0;
  await agent.saveMeta();
}

describe('maybeLiveIndex --local (RUSH-2118 default-listing gap)', () => {
  it('a bare `agents sessions --local` (no --active) issues zero ssh for a remote-host teammate', async () => {
    await makeRemoteTeammate('remote-running-local');

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    const index = await maybeLiveIndex({ local: true } as any);

    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
    // The teammate still shows up — read from cached meta.json, not dropped.
    expect(index?.size ?? 0).toBeGreaterThan(0);
  });

  it('sanity: without --local, the same remote-host teammate DOES get dialed', async () => {
    await makeRemoteTeammate('remote-running-nonlocal');

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    await maybeLiveIndex({} as any);

    // pullRemoteLogDelta (hosts/progress.ts) is the ssh call that mirrors a
    // running remote teammate's log — proves --local is the actual gate, not
    // some accidental global disablement.
    expect(sshExecRawMock).toHaveBeenCalled();
  });
});
