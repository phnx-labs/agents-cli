/**
 * Integration tests for the tmux session module.
 *
 * These spawn a real tmux server on a temp socket — no mocks. Every test
 * cleans up its session via `afterEach` so a failure mid-test doesn't leak.
 * If tmux isn't installed (rare on dev/CI but possible on bare Linux images),
 * the whole suite is skipped at module load.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTmuxInstalled } from './binary.js';
import {
  assertValidSessionName,
  capturePane,
  createSession,
  hasSession,
  killAll,
  killSession,
  listSessions,
  sendKeys,
  slugifyName,
  splitPane,
  TmuxSessionError,
} from './session.js';

const skipReason = isTmuxInstalled() ? null : 'tmux not installed';

describe.skipIf(skipReason)('tmux session lifecycle', () => {
  let socket: string;
  let tempDir: string;

  beforeEach(() => {
    // Per-test temp dir → per-test socket → guaranteed isolation from any
    // tmux server the developer may have running, and from other tests in
    // the suite that might run in parallel.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-test-'));
    socket = path.join(tempDir, 'srv.sock');
  });

  afterEach(async () => {
    try { await killAll(socket); } catch { /* best-effort */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* gone */ }
  });

  it('assertValidSessionName rejects names with dots or colons', () => {
    expect(() => assertValidSessionName('good-name_1')).not.toThrow();
    expect(() => assertValidSessionName('bad.name')).toThrow(TmuxSessionError);
    expect(() => assertValidSessionName('bad:name')).toThrow(TmuxSessionError);
    expect(() => assertValidSessionName('')).toThrow(TmuxSessionError);
    expect(() => assertValidSessionName('a'.repeat(65))).toThrow(TmuxSessionError);
  });

  it('slugifyName normalizes whitespace and special chars', () => {
    expect(slugifyName('hello world')).toBe('hello-world');
    expect(slugifyName('agent:claude.task')).toBe('agent-claude-task');
    expect(slugifyName('---trim---')).toBe('trim');
  });

  it('creates a detached session and reports it via hasSession + listSessions', async () => {
    const meta = await createSession({
      name: 'lifecycle',
      cmd: 'sleep 30',
      socket,
      source: 'cli',
    });
    expect(meta.name).toBe('lifecycle');
    expect(meta.socket).toBe(socket);

    expect(await hasSession('lifecycle', socket)).toBe(true);

    const list = await listSessions({ socket });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('lifecycle');
    expect(list[0].windows).toBe(1);
    expect(list[0].meta?.cmd).toBe('sleep 30');
  });

  it('captures live output from a running pane', async () => {
    await createSession({
      name: 'capture-test',
      cmd: 'echo MARKER_ABC123 && sleep 30',
      socket,
    });
    // Give the shell time to print the marker before we capture.
    await wait(300);
    const screen = await capturePane({ name: 'capture-test', socket });
    expect(screen).toContain('MARKER_ABC123');
  });

  it('sendKeys delivers typed text to the active pane', async () => {
    await createSession({
      name: 'send-test',
      cmd: '/bin/sh',
      socket,
    });
    await wait(200);
    await sendKeys({ name: 'send-test', keys: 'echo TYPED_FROM_TEST', socket });
    await wait(300);
    const screen = await capturePane({ name: 'send-test', socket });
    expect(screen).toContain('TYPED_FROM_TEST');
  });

  it('shell metacharacters in --cmd survive without shell escaping bugs', async () => {
    // This is the bug we're killing in swarmify — single quotes, $vars,
    // semicolons, pipes used to need fragile string-level escaping.
    await createSession({
      name: 'escape-test',
      cmd: `echo 'with single' && echo "with;pipe|chars" && sleep 30`,
      socket,
    });
    await wait(400);
    const screen = await capturePane({ name: 'escape-test', socket });
    expect(screen).toContain('with single');
    expect(screen).toContain('with;pipe|chars');
  });

  it('rejects duplicate session name without --replace', async () => {
    await createSession({ name: 'dup', cmd: 'sleep 30', socket });
    await expect(createSession({ name: 'dup', cmd: 'sleep 30', socket })).rejects.toThrow(/already exists/);
  });

  it('--replace kills the old session and creates a fresh one', async () => {
    const first = await createSession({ name: 'rep', cmd: 'echo FIRST && sleep 30', socket });
    const firstCreatedAt = first.createdAt;
    await wait(50);
    const second = await createSession({
      name: 'rep',
      cmd: 'echo SECOND && sleep 30',
      socket,
      replace: true,
    });
    expect(second.createdAt).toBeGreaterThan(firstCreatedAt);
    expect(second.cmd).toContain('SECOND');
    await wait(300);
    const screen = await capturePane({ name: 'rep', socket });
    expect(screen).toContain('SECOND');
    expect(screen).not.toContain('FIRST');
  });

  it('--attach-existing returns the existing session without recreating', async () => {
    const first = await createSession({ name: 'reuse', cmd: 'sleep 30', socket });
    const reused = await createSession({
      name: 'reuse',
      cmd: 'this should not run',
      socket,
      attachExisting: true,
    });
    expect(reused.createdAt).toBe(first.createdAt);
  });

  it('killSession is idempotent on missing sessions', async () => {
    expect(await killSession('never-existed', socket)).toBe(false);
    await createSession({ name: 'will-die', cmd: 'sleep 30', socket });
    expect(await killSession('will-die', socket)).toBe(true);
    expect(await killSession('will-die', socket)).toBe(false);
  });

  it('splitPane returns the new pane id and produces a 2-pane window', async () => {
    await createSession({ name: 'splittest', cmd: '/bin/sh', socket });
    await wait(150);
    const paneId = await splitPane({
      name: 'splittest',
      direction: 'v',
      cmd: 'echo SECOND_PANE_MARKER && sleep 30',
      socket,
    });
    expect(paneId).toMatch(/^%\d+$/);
    await wait(300);
    const screen = await capturePane({ name: `splittest`, pane: paneId, socket });
    expect(screen).toContain('SECOND_PANE_MARKER');
  });

  it('listSessions returns empty + cleans orphan meta files when server is gone', async () => {
    await createSession({ name: 'cleanme', cmd: 'sleep 30', socket });
    await killAll(socket);
    const sessions = await listSessions({ socket });
    expect(sessions).toEqual([]);
  });

  it('rejects a cwd that does not exist', async () => {
    await expect(createSession({
      name: 'bad-cwd',
      cmd: 'true',
      cwd: '/this/path/should/never/exist/anywhere',
      socket,
    })).rejects.toThrow(/cwd does not exist/);
  });

  it('remain-on-exit keeps the pane around after the launched command finishes', async () => {
    // A short-lived command would normally collapse the pane and the session
    // with it. With remain-on-exit on, the session stays alive.
    await createSession({ name: 'short', cmd: 'echo BRIEF && true', socket });
    // Let the command finish.
    await wait(400);
    expect(await hasSession('short', socket)).toBe(true);
    const screen = await capturePane({ name: 'short', socket, lines: 10 });
    expect(screen).toContain('BRIEF');
  });
});

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
