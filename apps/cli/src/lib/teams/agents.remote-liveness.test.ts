/**
 * RUSH-2366 — a dead `--device` teammate reported RUNNING forever. The old
 * liveness probe only had two states: an `.exit` sentinel present ("DEAD") or
 * absent ("ALIVE"). A remote process that is genuinely gone but never got the
 * chance to WRITE its `.exit` sentinel — killed, the box lost, OOM — collapsed
 * into the same "no sentinel" bucket as a still-running teammate, so it stayed
 * RUNNING forever and `agents teams resume` refused to relaunch it (a RUNNING
 * teammate routes to steer/mailbox, never resume).
 *
 * The fix adds a third state, GONE (process confirmed dead AND no sentinel at
 * all), resolved in one round-trip via remoteLivenessSnippet/
 * parseRemoteLivenessState — kept distinct from EXITED (sentinel present,
 * possibly still mid-write) so a momentarily-empty `.exit` never misfires as a
 * spurious FAILED.
 *
 * These tests exercise the real AgentManager/AgentProcess lifecycle against a
 * temp meta.json dir (no mocking of the code under test) and stub only the ssh
 * network boundary — same pattern as agents.remote-poll.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { sshExecMock, sshExecRawMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn(),
  sshExecRawMock: vi.fn(),
}));

vi.mock('../ssh-exec.js', async () => {
  const actual = await vi.importActual<typeof import('../ssh-exec.js')>('../ssh-exec.js');
  return { ...actual, sshExec: sshExecMock, sshExecRaw: sshExecRawMock };
});

import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-liveness-'));
}

async function makeRemoteRunning(base: string, id: string): Promise<AgentProcess> {
  const agent = new AgentProcess(
    id, 'dist-team', 'claude', 'do a thing',
    null, 'plan', null, AgentStatus.RUNNING, new Date(), null, base,
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

describe('remote GONE detection — a killed --device teammate resolves terminal (RUSH-2366)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    sshExecMock.mockReset();
    sshExecRawMock.mockReset();
  });

  it('GONE (process dead, no .exit sentinel at all) resolves FAILED, not RUNNING forever', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-killed';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    // remoteLivenessSnippet emits "<id> GONE" when the sentinel is absent and
    // `kill -0 <remotePid>` fails — the wrapper never got to write $?.
    sshExecMock.mockReturnValue({ code: 0, stdout: `${id} GONE\n`, stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all).toHaveLength(1);
    expect(all[0].status).toBe(AgentStatus.FAILED);
    expect(all[0].completedAt).not.toBeNull();
  });

  it('EXITED with a parseable code resolves COMPLETED/FAILED from that code', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-exited';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    sshExecMock.mockReturnValue({ code: 0, stdout: `${id} EXITED 1\n`, stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.FAILED);
  });

  it('EXITED with an empty (mid-write) code stays RUNNING — does not misfire as GONE', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-mid-write';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    // Sentinel file exists (EXITED) but its contents haven't landed yet.
    sshExecMock.mockReturnValue({ code: 0, stdout: `${id} EXITED\n`, stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.RUNNING);
  });

  it('ALIVE (process still running, no sentinel) stays RUNNING', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-alive';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    sshExecMock.mockReturnValue({ code: 0, stdout: `${id} ALIVE\n`, stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.RUNNING);
  });

  it('a transient ssh failure (code null) leaves the teammate RUNNING rather than reaping it', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-ssh-blip';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: null, stdout: Buffer.alloc(0), stderr: 'connection refused' });
    sshExecMock.mockReturnValue({ code: null, stdout: '', stderr: 'connection refused' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.RUNNING);
  });
});
