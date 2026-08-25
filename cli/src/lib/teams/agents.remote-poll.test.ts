/**
 * RUSH-2118: `agents sessions --active --local` fired ~1 ssh round-trip per
 * remote-host teammate (finished or not) on EVERY poll — `updateStatusFromProcess`
 * → `readNewEvents` → `syncRemoteMirror` dialed the host unconditionally, and
 * `--local` never gated it at all. On a box with 30 completed teammates that was
 * ~60 real ssh calls (loadExistingAgents polls once at construction, listAll polls
 * again) for a query that is supposed to be this-machine-only.
 *
 * These tests exercise the real AgentManager/AgentProcess lifecycle against a temp
 * meta.json dir (no mocking of the code under test) and stub only the ssh network
 * boundary, asserting it is NEVER called for the two cases the fix targets:
 *   (a) a `--local` (localOnly) query, even against a still-RUNNING remote teammate
 *   (b) a terminal-status remote teammate, --local or not
 * A third "sanity" test proves the fix didn't over-broadly kill polling for a
 * genuinely running remote teammate under a normal (non --local) query.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { sshExecMock, sshExecRawMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn(),
  sshExecRawMock: vi.fn(),
}));

// Keep everything else in ssh-exec.js real (shellQuote, assertValidSshTarget,
// …); only the two functions that actually reach the network are stubbed.
vi.mock('../ssh-exec.js', async () => {
  const actual = await vi.importActual<typeof import('../ssh-exec.js')>('../ssh-exec.js');
  return { ...actual, sshExec: sshExecMock, sshExecRaw: sshExecRawMock };
});

import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-poll-'));
}

/** A remote-host teammate (dispatched via `agents teams add --device`): no local
 * pid, lifecycle lives entirely on the host via hostName/hostTarget/remoteLog. */
async function makeRemoteTeammate(base: string, id: string, status: AgentStatus): Promise<AgentProcess> {
  const agent = new AgentProcess(
    id, 'dist-team', 'claude', 'do a thing',
    null, 'plan', null, status, new Date(),
    status === AgentStatus.RUNNING ? null : new Date(), base,
  );
  agent.hostName = 'yosemite-s0';
  agent.hostTarget = 'yosemite-s0.tail1a85a1.ts.net';
  agent.repoPath = '/home/muqsit/.agents/repos/dist-team';
  agent.remotePid = 4242;
  agent.remoteLog = '$HOME/.agents/.cache/hosts/aaaaaaaa.log';
  agent.remoteExit = '$HOME/.agents/.cache/hosts/aaaaaaaa.exit';
  agent.remoteLogOffset = 0;
  await agent.saveMeta();
  return agent;
}

describe('remote-host teammate polling (RUSH-2118)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    sshExecMock.mockReset();
    sshExecRawMock.mockReset();
  });

  it('a --local (localOnly) query issues zero ssh for a still-RUNNING remote teammate', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeRemoteTeammate(base, 'remote-running', AgentStatus.RUNNING);

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    const mgr = new AgentManager(50, base, undefined, undefined, undefined, true);
    const all = await mgr.listAll();

    expect(all).toHaveLength(1);
    // Cached meta.json state stands as-is — never dialed, never overwritten.
    expect(all[0].status).toBe(AgentStatus.RUNNING);
    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
  });

  it('a terminal-status remote teammate is never re-polled, --local or not', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeRemoteTeammate(base, 'remote-done', AgentStatus.COMPLETED);

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    // A normal `--active` poll — NOT --local. Even here, a teammate that has
    // already resolved terminal must not be dialed again: its `.exit` sentinel
    // and final log bytes were already captured on the poll that resolved it.
    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all).toHaveLength(1);
    expect(all[0].status).toBe(AgentStatus.COMPLETED);
    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
  });

  it('sanity: a still-RUNNING remote teammate DOES get polled when not --local', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeRemoteTeammate(base, 'remote-running-2', AgentStatus.RUNNING);

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    const mgr = new AgentManager(50, base); // no localOnly — polling must remain intact
    await mgr.listAll();

    // pullRemoteLogDelta (hosts/progress.ts) is the ssh call that mirrors a
    // running remote teammate's new log bytes — proves the fix didn't disable
    // polling outright, only the terminal/--local cases.
    expect(sshExecRawMock).toHaveBeenCalled();
  });
});
