/**
 * RUSH-2118 follow-up (prix-cloud review on PR #1827, two rounds): the
 * `--local` help text promises "this machine only" for BOTH the default
 * listing and `--active` (sessions.ts `--local` option help). The `--active`
 * path was fixed first to never dial a remote-host teammate under `--local`,
 * but two more call sites called the local-only `getActiveSessions()` with no
 * `localOnly` threaded through, each still firing a real ssh round-trip:
 *
 *   1. `maybeLiveIndex()` — enriches every row of the bare (non `--active`)
 *      listing with a live glyph/preview.
 *   2. `renderSessionPreview()` — backs `--preview <id>`, which is freely
 *      combinable with `--local` (no mutual exclusion), so
 *      `agents sessions --local --preview <id>` reached it too.
 *
 * HOME is pinned to a temp dir BEFORE importing anything that resolves
 * `~/.agents` (teams/agents.ts, sessions.ts) or `~/.claude` (discover.ts), so
 * AgentManager's default construction (no explicit baseDir — neither
 * `maybeLiveIndex` nor `renderSessionPreview` has a way to inject one) and
 * `discoverSessions()`'s filesystem scan both read/write under our temp
 * fixture instead of the real fleet. Only the ssh network boundary is
 * stubbed; AgentManager/AgentProcess/discoverSessions run for real.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

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

const { maybeLiveIndex, renderSessionPreview } = await import('./sessions.js');
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

/**
 * Minimal discoverable Claude transcript so `discoverSessions()` (which
 * `renderSessionPreview` calls) resolves a real session for `query` to key
 * `--preview` off. Mirrors `writeClaudeSession` in sessions.test.ts.
 */
function writeClaudeSession(sessionId: string, cwd: string): void {
  fs.mkdirSync(cwd, { recursive: true });
  const projectKey = cwd.replace(/[/.]/g, '-');
  const sessionsDir = path.join(fakeHome, '.claude', 'projects', projectKey);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      cwd,
      sessionId,
      version: '2.1.110',
      gitBranch: 'main',
      message: { role: 'user', content: 'RUSH-2118 preview fixture' },
    }) + '\n',
    'utf-8',
  );
}

// Windows-fs-incompatible (RUSH-2215): the fixture keys the transcript dir off
// the absolute cwd (`.claude/projects/<cwd>`), which on Windows embeds a drive
// colon (`C:\...`) mid-path and mkdir rejects it; and the in-process session
// index keeps a sqlite handle open that Windows locks, so afterAll's rmSync of
// the temp home fails EPERM. Both describes run on POSIX only.
describe.skipIf(process.platform === 'win32')('maybeLiveIndex --local (RUSH-2118 default-listing gap)', () => {
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

// Windows-fs-incompatible (RUSH-2215): see the note on the sibling describe above.
describe.skipIf(process.platform === 'win32')('renderSessionPreview --local (RUSH-2118 --preview gap)', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  afterAll(() => consoleLogSpy.mockRestore());

  it('`agents sessions --local --preview <id>` issues zero ssh for a remote-host teammate', async () => {
    const sessionId = crypto.randomUUID();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rush2118-preview-cwd-'));
    writeClaudeSession(sessionId, cwd);
    await makeRemoteTeammate('remote-running-preview-local');

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    await renderSessionPreview(sessionId, { local: true });

    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('an exact local UUID preview does not dial an unrelated remote teammate', async () => {
    const sessionId = crypto.randomUUID();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rush2118-preview-cwd-'));
    writeClaudeSession(sessionId, cwd);
    await makeRemoteTeammate('remote-running-preview-nonlocal');

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    await renderSessionPreview(sessionId, {});

    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
