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
import { isTmuxInstalled, runTmux } from './binary.js';
import {
  assertValidSessionName,
  capturePane,
  createSession,
  ensureSessionHookRepaired,
  hasSession,
  killAll,
  killSession,
  listClients,
  listSessions,
  paneExitStatus,
  prepareSessionForResume,
  reapDeadTmuxPanes,
  reconcileSessionHooks,
  sendKeys,
  setSessionHook,
  slugifyName,
  splitPane,
  AGENT_HOOK_SCHEMA,
  agentPaneDiedHook,
  AGENTS_TMUX_HISTORY_LIMIT,
  buildCreateSessionArgs,
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

  it('builds session creation with agents-cli server ergonomics before new-session', () => {
    const args = buildCreateSessionArgs({ name: 'ergonomic', cmd: 'sleep 30' }, '/agents/tmux-defaults.conf');
    expect(args).toEqual([
      '-f', '/agents/tmux-defaults.conf',
      'set-option', '-g', 'remain-on-exit', 'on', ';',
      'new-session', '-d', '-s', 'ergonomic', '-P', '-F', '#{pane_id}',
      '--', 'sh', '-c', 'sleep 30',
    ]);
  });

  it('keeps explicit user tmux options and mouse-copy bindings', async () => {
    const userHome = path.join(tempDir, 'home');
    fs.mkdirSync(userHome);
    fs.writeFileSync(path.join(userHome, '.tmux.conf'), [
      'set-option -g mouse off',
      'set-option -s set-clipboard external',
      'set-option -g history-limit 50000',
      'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X cancel',
      'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X cancel',
    ].join('\n'));

    await createSession({
      name: 'user-config',
      cmd: 'sleep 30',
      socket,
      env: { ...process.env, HOME: userHome, XDG_CONFIG_HOME: path.join(userHome, '.config') },
    });

    expect((await runTmux({ socket, args: ['show-options', '-gv', 'mouse'] })).stdout.trim()).toBe('off');
    expect((await runTmux({ socket, args: ['show-options', '-sv', 'set-clipboard'] })).stdout.trim()).toBe('external');
    expect((await runTmux({ socket, args: ['show-options', '-gv', 'history-limit'] })).stdout.trim()).toBe('50000');
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      const binding = (await runTmux({ socket, args: ['list-keys', '-T', table, 'MouseDragEnd1Pane'] })).stdout;
      expect(binding).toContain('cancel');
      expect(binding).not.toContain('copy-selection-no-clear');
    }
  });

  it('configures mouse, OSC 52 clipboard, scrollback, and non-clearing mouse copy on its socket', async () => {
    const unconfiguredHome = path.join(tempDir, 'unconfigured-home');
    fs.mkdirSync(unconfiguredHome);
    await createSession({
      name: 'ergonomic',
      cmd: 'sleep 30',
      socket,
      env: {
        ...process.env,
        HOME: unconfiguredHome,
        XDG_CONFIG_HOME: path.join(unconfiguredHome, '.config'),
      },
    });

    expect((await runTmux({ socket, args: ['show-options', '-gv', 'mouse'] })).stdout.trim()).toBe('on');
    expect((await runTmux({ socket, args: ['show-options', '-sv', 'set-clipboard'] })).stdout.trim()).toBe('on');
    expect((await runTmux({ socket, args: ['show-options', '-gv', 'history-limit'] })).stdout.trim())
      .toBe(String(AGENTS_TMUX_HISTORY_LIMIT));

    for (const table of ['copy-mode', 'copy-mode-vi']) {
      const binding = (await runTmux({ socket, args: ['list-keys', '-T', table, 'MouseDragEnd1Pane'] })).stdout;
      expect(binding).toContain('copy-selection-no-clear');
    }
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

  it('persists the redacted metaCmd to disk while executing the real cmd (RUSH-1758)', async () => {
    // The real command carries a secret value; the persisted informational copy
    // must not. Prove: (a) meta.cmd stored on disk is the redacted string,
    // (b) the secret value never appears in the meta, (c) the REAL cmd still ran.
    const secret = 'SECRET_VALUE_XYZ789';
    const outFile = path.join(tempDir, 'ran.txt');
    const meta = await createSession({
      name: 'redact',
      cmd: `sh -c 'printf ${secret} > ${outFile}; sleep 30'`,
      metaCmd: 'exec env TOKEN=<redacted> claude',
      socket,
    });
    expect(meta.cmd).toBe('exec env TOKEN=<redacted> claude');
    expect(JSON.stringify(meta)).not.toContain(secret);

    // Read back what actually hit disk (listSessions reads the persisted meta).
    const list = await listSessions({ socket });
    expect(list[0].meta?.cmd).toBe('exec env TOKEN=<redacted> claude');
    expect(JSON.stringify(list[0].meta)).not.toContain(secret);

    // The real cmd (with the secret) still executed in the live pane.
    await wait(400);
    expect(fs.readFileSync(outFile, 'utf8')).toContain(secret);
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

  it('native resume reaps a metadata-less retained dead pane instead of attaching it', async () => {
    await runTmux({
      socket,
      args: [
        'set-option', '-g', 'remain-on-exit', 'on', ';',
        'new-session', '-d', '-s', 'legacy-dead-resume', '--', 'sh', '-c', 'exit 0',
      ],
    });

    let pane = '';
    let dead = '';
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await runTmux({
        socket,
        args: ['list-panes', '-t', 'legacy-dead-resume', '-F', '#{pane_id} #{pane_dead}'],
        throwOnError: false,
      });
      [pane = '', dead = ''] = result.stdout.trim().split(/\s+/);
      if (/^%\d+$/.test(pane) && dead === '1') break;
      await wait(50);
    }
    expect(pane).toMatch(/^%\d+$/);
    expect(dead).toBe('1');

    expect((await prepareSessionForResume('legacy-dead-resume', socket)).decision).toBe('create');
    expect(await hasSession('legacy-dead-resume', socket)).toBe(false);
  });

  it('native resume reuses a positively living existing pane', async () => {
    await createSession({ name: 'living-resume', cmd: 'sleep 30', socket });

    expect((await prepareSessionForResume('living-resume', socket)).decision).toBe('attach');
    expect(await hasSession('living-resume', socket)).toBe(true);
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

  it('createSession captures the first pane id and records it on the meta', async () => {
    const meta = await createSession({ name: 'paneid', cmd: 'sleep 30', socket });
    expect(meta.pane).toMatch(/^%\d+$/);
    // The captured pane is a real, addressable pane in the session.
    const screen = await capturePane({ name: 'paneid', pane: meta.pane, socket });
    expect(typeof screen).toBe('string');
  });

  it('listClients returns [] for a detached session (no terminal attached)', async () => {
    await createSession({ name: 'noclients', cmd: 'sleep 30', socket });
    // A detached tmux session has no attached clients — the "detached" state the
    // viewing-in resolver keys off.
    expect(await listClients(socket)).toEqual([]);
  });

  it('paneExitStatus reports the dead pane exit code once the process finishes', async () => {
    // remain-on-exit (set on the agent pane by createSession) keeps the pane around dead,
    // so we can read the wrapped command's exit status — the spawn-wrap's exit-code path.
    const meta = await createSession({ name: 'exitcode', cmd: 'sh -c "exit 3"', socket });
    expect(meta.pane).toBeTruthy();
    await wait(400);
    // See waitForExitStatus below: `pane_dead` can flip before `pane_dead_status`
    // is populated under load, so poll for both together rather than one read.
    const exit = await waitForExitStatus(meta.pane!, socket);
    expect(exit.dead).toBe(true);
    expect(exit.status).toBe(3);
  });

  it('paneExitStatus reports a live pane as not dead', async () => {
    const meta = await createSession({ name: 'stillalive', cmd: 'sleep 30', socket });
    const exit = await paneExitStatus(meta.pane!, socket);
    expect(exit.dead).toBe(false);
  });

  it('a fast-failing agent leaves its error readable in the dead pane (runInTmux failure recap)', async () => {
    // The exact scenario runInTmux now surfaces: an agent that dies the instant
    // it spawns (e.g. a gutted install crashing with ENOENT). Before the fix the
    // pane-died hook detached the client and the error vanished; the recap works
    // only because remain-on-exit on the agent pane keeps the dead pane capturable until teardown.
    const meta = await createSession({
      name: 'fastfail',
      cmd: `sh -c 'echo "spawn .../codex ENOENT" >&2; exit 1'`,
      socket,
    });
    expect(meta.pane).toBeTruthy();
    await wait(400);
    // tmux can flip `pane_dead` to 1 before `pane_dead_status` is populated —
    // the same class of async settle race as the capture below, just on a
    // different field. Poll both together instead of trusting a single read.
    const exit = await waitForExitStatus(meta.pane!, socket);
    expect(exit.dead).toBe(true);
    expect(exit.status).toBe(1);
    // capture-pane must reach into scrollback (as runInTmux does with -S -200)
    // to recover the crash output — the dead pane's VISIBLE screen is just the
    // "Pane is dead" banner, so a history-less capture would miss the error.
    // The pty write of the crash line and tmux's own SIGCHLD-driven pane-dead
    // transition are two independent async chains; on a loaded runner the
    // dead-pane banner can render before the crash line has settled into the
    // pane's screen/scrollback (RUSH-2342 — observed as a bare "Pane is dead"
    // capture with no ENOENT on the crabbox VM, despite paneExitStatus above
    // already confirming the process itself was dead+exit 1). Poll the same
    // real capturePane() until the crash text lands, exactly like waitForPanes
    // polls for pane teardown below — this still fails for real if the error
    // text never appears, it just tolerates how long that takes under load.
    const screen = await waitForCapture({ name: 'fastfail', pane: meta.pane!, socket, lines: 200 }, 'ENOENT');
    expect(screen).toContain('ENOENT');
  });

  it('remain-on-exit keeps the pane around after the launched command finishes', async () => {
    // A short-lived command would normally collapse the pane and the session
    // with it. With remain-on-exit on the agent pane, the session stays alive.
    await createSession({ name: 'short', cmd: 'echo BRIEF && true', socket });
    // Let the command finish.
    await wait(400);
    expect(await hasSession('short', socket)).toBe(true);
    const screen = await capturePane({ name: 'short', socket, lines: 10 });
    expect(screen).toContain('BRIEF');
  });

  it('setSessionHook reports whether tmux accepted the hook', async () => {
    await createSession({ name: 'hook-result', cmd: 'sleep 30', socket });
    expect(await setSessionHook('hook-result', 'pane-died', 'display-message accepted', socket)).toBe(true);
    expect(await setSessionHook('missing-session', 'pane-died', 'display-message rejected', socket)).toBe(false);
  });

  it('pane-guarded pane-died hook: exiting a user split closes only that split, agent pane survives', async () => {
    // Replicates runInTmux()'s hook wiring: a pane-died hook scoped to the AGENT
    // pane via #{hook_pane}. Exiting a user-created split must close that split in
    // place (kill-pane, else-branch) WITHOUT detaching — the agent pane keeps
    // running. Without the #{hook_pane} guard, exiting any split detached the
    // whole client and kicked the user out of tmux.
    const meta = await createSession({ name: 'guardsplit', cmd: 'sleep 30', socket });
    const agentPane = meta.pane!;
    expect(agentPane).toMatch(/^%\d+$/);
    // Same hook string runInTmux installs (detach agent-pane / kill-pane others).
    await setSessionHook(
      'guardsplit',
      'pane-died',
      agentPaneDiedHook('guardsplit', agentPane),
      socket,
    );
    // User opens a split (a plain shell), then exits it.
    const splitPaneId = await splitPane({ name: 'guardsplit', direction: 'v', cmd: '/bin/sh', socket });
    await wait(200);
    let panes = (await runTmux({ socket, args: ['list-panes', '-t', 'guardsplit', '-F', '#{pane_id}'] })).stdout.trim().split('\n');
    expect(panes).toHaveLength(2);
    await runTmux({ socket, args: ['send-keys', '-t', splitPaneId, 'exit', 'Enter'] });

    // Session is still alive, the split is gone (no lingering dead husk), and the
    // agent pane is still live — i.e. the user was NOT kicked out. Poll for the
    // kill-pane to land rather than racing a fixed sleep.
    panes = await waitForPanes('guardsplit', socket, 1);
    expect(await hasSession('guardsplit', socket)).toBe(true);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toBe(`${agentPane}:0`);
  });

  it('pane-guarded pane-died hook: exiting the agent pane fires the guard (dead husk kept for status read)', async () => {
    // The true-branch: when the AGENT pane exits, the hook fires. remain-on-exit
    // on the agent pane keeps it as a dead husk so runInTmux can read the exit status before teardown.
    const meta = await createSession({ name: 'guardagent', cmd: 'sh -c "exit 7"', socket });
    const agentPane = meta.pane!;
    await setSessionHook(
      'guardagent',
      'pane-died',
      agentPaneDiedHook('guardagent', agentPane),
      socket,
    );
    await wait(400);
    // Guard matched the agent pane → the else-branch kill-pane did NOT run, so the
    // dead husk survives and its exit status is still readable.
    const exit = await paneExitStatus(agentPane, socket);
    expect(exit.dead).toBe(true);
    expect(exit.status).toBe(7);
  });

  it('reconcileSessionHooks retrofits the guarded hook onto a session left with the OLD unconditional one', async () => {
    // A session a pre-fix binary created: the OLD unconditional `detach-client`
    // hook fired on ANY pane death, so exiting a user split detached the whole
    // client (and, with no kill-pane, left the split as a dead husk).
    const meta = await createSession({ name: 'ag-reco-old', cmd: 'sleep 30', socket });
    const agentPane = meta.pane!;
    await setSessionHook('ag-reco-old', 'pane-died', 'detach-client -s =ag-reco-old', socket);

    const res = await reconcileSessionHooks(socket);
    expect(res.reconciled).toBeGreaterThanOrEqual(1);
    // The schema marker is stamped so a re-run skips this session.
    const marker = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'ag-reco-old', '@ag_hook_schema'] })).stdout.trim();
    expect(marker).toBe(String(AGENT_HOOK_SCHEMA));

    // The guarded hook is now in force: open a split and exit it → only that split
    // closes (kill-pane, no lingering husk), the agent pane survives. Under the OLD
    // hook this pane would have stayed as a dead second pane.
    const splitPaneId = await splitPane({ name: 'ag-reco-old', direction: 'v', cmd: '/bin/sh', socket });
    await wait(200);
    await runTmux({ socket, args: ['send-keys', '-t', splitPaneId, 'exit', 'Enter'] });
    expect(await hasSession('ag-reco-old', socket)).toBe(true);
    const panes = await waitForPanes('ag-reco-old', socket, 1);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toBe(`${agentPane}:0`);
  });

  it('reconcileSessionHooks is idempotent and leaves non-run sessions alone', async () => {
    await createSession({ name: 'ag-reco-idem', cmd: 'sleep 30', socket });
    await createSession({ name: 'user-made', cmd: 'sleep 30', socket }); // no `ag-` prefix

    const first = await reconcileSessionHooks(socket);
    expect(first.reconciled).toBeGreaterThanOrEqual(1);
    // Marker present → the second pass is a no-op.
    const second = await reconcileSessionHooks(socket);
    expect(second.reconciled).toBe(0);
    // The non-run session was never touched (no marker stamped).
    const r = await runTmux({ socket, args: ['show-options', '-v', '-t', 'user-made', '@ag_hook_schema'], throwOnError: false });
    expect(r.stdout.trim()).toBe('');
  });

  // RUSH-2435: the 5-minute tmux-reconcile poll that used to retrofit a stale
  // hook was deleted (RUSH-2495) with nothing replacing it — a legacy session
  // could sit unrepaired indefinitely. ensureSessionHookRepaired is the
  // steady-state fix: a single-session repair called right before attach.
  it('ensureSessionHookRepaired retrofits a stale hook on the ONE session named', async () => {
    await createSession({ name: 'ag-repair-one', cmd: 'sleep 30', socket });
    await setSessionHook('ag-repair-one', 'pane-died', 'detach-client -s =ag-repair-one', socket);
    const before = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'ag-repair-one', '@ag_hook_schema'], throwOnError: false })).stdout.trim();
    expect(before).toBe('');

    await ensureSessionHookRepaired('ag-repair-one', socket);

    const marker = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'ag-repair-one', '@ag_hook_schema'] })).stdout.trim();
    expect(marker).toBe(String(AGENT_HOOK_SCHEMA));
  });

  it('ensureSessionHookRepaired is a no-op for a non-run (non `ag-`) session', async () => {
    await createSession({ name: 'user-made-2', cmd: 'sleep 30', socket });
    await setSessionHook('user-made-2', 'pane-died', 'detach-client -s =user-made-2', socket);

    await ensureSessionHookRepaired('user-made-2', socket);

    const marker = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'user-made-2', '@ag_hook_schema'], throwOnError: false })).stdout.trim();
    expect(marker).toBe('');
  });

  it('prepareSessionForResume repairs a stale hook on the session it decides to attach', async () => {
    await createSession({ name: 'ag-resume-repair', cmd: 'sleep 30', socket });
    await setSessionHook('ag-resume-repair', 'pane-died', 'detach-client -s =ag-resume-repair', socket);

    const decision = await prepareSessionForResume('ag-resume-repair', socket);
    expect(decision.decision).toBe('attach');

    const marker = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'ag-resume-repair', '@ag_hook_schema'] })).stdout.trim();
    expect(marker).toBe(String(AGENT_HOOK_SCHEMA));
  });
});

describe.skipIf(skipReason)('reapDeadTmuxPanes', () => {
  let socket: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-reap-'));
    socket = path.join(tempDir, 'test.sock');
  });

  afterEach(async () => {
    await killAll(socket).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty result when no server is running', async () => {
    const result = await reapDeadTmuxPanes(socket);
    expect(result.reaped).toBe(0);
    expect(result.sessions).toEqual([]);
  });

  it('reaps a session whose only pane is dead', async () => {
    // Create a session that exits immediately.
    const { name } = await createSession({ name: 'dead-reap-test', cmd: 'true', socket });
    // Wait for the pane to die.
    const pane = (
      await runTmux({ socket, args: ['list-panes', '-t', `=${name}`, '-F', '#{pane_id}'], throwOnError: false })
    ).stdout.trim().split('\n')[0];
    await waitForExitStatus(pane, socket, 8000);

    const result = await reapDeadTmuxPanes(socket);
    expect(result.reaped).toBeGreaterThanOrEqual(1);
    expect(result.sessions).toContain(name);
    // Session must be gone.
    expect(await hasSession(name, socket)).toBe(false);
  });

  it('does NOT reap a session with a live pane', async () => {
    // Create a long-running session.
    const { name } = await createSession({ name: 'alive-reap-test', cmd: 'sleep 60', socket });

    const result = await reapDeadTmuxPanes(socket);
    expect(result.sessions).not.toContain(name);
    // Session must still exist.
    expect(await hasSession(name, socket)).toBe(true);
  });
});

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Poll `list-panes` until the session has exactly `expected` panes, or the
 * timeout elapses. Returns the last observed `#{pane_id}:#{pane_dead}` rows.
 *
 * A pane exiting is asynchronous end-to-end: the shell processes `exit`, tmux
 * fires the `pane-died` hook, and the hook's `kill-pane` then removes the dead
 * pane — a chain that can exceed any fixed sleep under CI load, leaving the
 * dead pane transiently listed (the `expected 1, got 2` flake). Polling settles
 * as soon as the count is right and only fails if it genuinely never converges.
 */
async function waitForPanes(
  name: string,
  socket: string,
  expected: number,
  // The pane teardown this waits on (the guarded pane-died hook killing the dead
  // split) is a real async tmux operation whose latency balloons on a loaded CI
  // runner. 5s was too tight under the full parallel suite; give it generous
  // headroom (still well under the 30s vitest testTimeout). The loop still
  // returns the instant the count converges, so the ceiling only bites on a
  // genuinely stuck teardown.
  timeoutMs = 20000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let panes: string[] = [];
  for (;;) {
    panes = (await runTmux({ socket, args: ['list-panes', '-t', name, '-F', '#{pane_id}:#{pane_dead}'] }))
      .stdout.trim().split('\n').filter(Boolean);
    if (panes.length === expected || Date.now() >= deadline) return panes;
    await wait(50);
  }
}

/**
 * Poll the real `paneExitStatus()` until it reports a finished exit (both
 * `dead` AND a defined `status`), or the timeout elapses. `pane_dead` and
 * `pane_dead_status` are two separate tmux format variables that can settle
 * at slightly different times under load, so a single read can observe
 * `dead: true, status: undefined`. Returns the last observed result either
 * way — a genuine miss still fails the caller's assertions.
 */
async function waitForExitStatus(
  pane: string,
  socket: string,
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<typeof paneExitStatus>>> {
  const deadline = Date.now() + timeoutMs;
  let exit: Awaited<ReturnType<typeof paneExitStatus>> = { found: false, dead: false };
  for (;;) {
    exit = await paneExitStatus(pane, socket);
    if ((exit.dead && exit.status !== undefined) || Date.now() >= deadline) return exit;
    await wait(50);
  }
}

/**
 * Poll the real `capturePane()` until its output contains `needle`, or the
 * timeout elapses. Same rationale as `waitForPanes`: a dead pane's screen
 * content settles asynchronously relative to tmux's own dead/exit-status
 * bookkeeping, and a fixed sleep that is fine locally can be too tight on a
 * loaded CI runner. Returns the last observed capture either way, so a
 * genuine miss (the text never appears) still fails the caller's assertion —
 * this only removes timing flakiness, it does not weaken what is checked.
 */
async function waitForCapture(
  opts: Parameters<typeof capturePane>[0],
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let screen = '';
  for (;;) {
    screen = await capturePane(opts);
    if (screen.includes(needle) || Date.now() >= deadline) return screen;
    await wait(50);
  }
}
