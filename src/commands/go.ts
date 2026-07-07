/**
 * `agents sessions go [id]` — jump to a LIVE agent session's terminal.
 *
 * No id  -> the SAME rich interactive picker as `agents sessions` (worktree, PR,
 *           changed files, tools, tests, last response — this-machine first),
 *           filtered to sessions that are running right now.
 * With id -> jump directly.
 *
 * "Jump" is not "resume" (which spawns a new process from the transcript). It walks
 * you to the already-running terminal:
 *   local tmux    -> attach (switch-client when already inside tmux)
 *   local Ghostty -> focus its tab (Cmd+<n> via System Events; tab # from ghostty-tabs)
 *   remote tmux   -> ssh -tt + tmux attach (pane->session resolved on the remote)
 *   otherwise     -> refuse with a reason + resume hint (cloud / no attach rail)
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getActiveSessions, findSessionFileForKind, type ActiveSession } from '../lib/session/active.js';
import { gatherRemoteActive } from '../lib/session/remote-active.js';
import { discoverSessions } from '../lib/session/discover.js';
import type { SessionMeta, SessionAgentId } from '../lib/session/types.js';
import { dedupeByMachineSession, mergeLocalFirst, pickSessionInteractive } from './sessions.js';
import { machineId } from '../lib/session/sync/config.js';
import { isInteractiveTerminal } from './utils.js';
import { attachTmux, runTmux } from '../lib/tmux/binary.js';
import { getDefaultSocketPath } from '../lib/tmux/paths.js';
import { sshStream, assertValidSshTarget, shellQuote } from '../lib/ssh-exec.js';
import { enumerateGhosttyTabs, assignGhosttyTabs } from '../lib/session/ghostty-tabs.js';

const execFileAsync = promisify(execFile);

export function registerGoCommand(program: Command): void {
  program
    .command('go')
    .argument('[id]', 'Short/full session id to jump to; omit for an interactive picker')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .description('Jump to a live agent session — attach its tmux, or focus its terminal tab')
    .action(async (id: string | undefined, opts: { local?: boolean }) => {
      await goAction(id, opts);
    });
}

/** Live jump targets (local + remote), keyed by session id. Cloud excluded (no pid). */
export async function gatherLiveTargets(local: boolean): Promise<{ self: string; activeById: Map<string, ActiveSession> }> {
  const self = machineId();
  const localActive = await getActiveSessions();
  for (const s of localActive) if (!s.machine) s.machine = self;
  let active = localActive;
  if (!local) {
    try {
      const remote = await gatherRemoteActive();
      active = dedupeByMachineSession([...localActive, ...remote.sessions]);
    } catch { /* remote sweep is best-effort */ }
  }
  const activeById = new Map<string, ActiveSession>();
  for (const s of active) if (s.context !== 'cloud' && s.sessionId) activeById.set(s.sessionId, s);
  return { self, activeById };
}

/** Interactive pick over the live sessions' rich SessionMeta; returns the chosen live session. */
export async function pickLiveTarget(
  activeById: Map<string, ActiveSession>,
  self: string,
  message: string,
  enterHint: string,
): Promise<ActiveSession | null> {
  const pool = await buildLivePool(activeById, self);
  if (pool.length === 0) return null;
  const picked = await pickSessionInteractive(pool, message, undefined, 0, enterHint);
  if (!picked) return null;
  return activeById.get(picked.session.id) ?? null;
}

async function goAction(id: string | undefined, opts: { local?: boolean }): Promise<void> {
  const { self, activeById } = await gatherLiveTargets(!!opts.local);

  if (activeById.size === 0) {
    console.log(chalk.gray('No live agent sessions to jump to.'));
    return;
  }

  // Direct jump by id — no picker.
  if (id) {
    const q = id.toLowerCase();
    const matches = [...activeById.values()].filter((s) => s.sessionId!.toLowerCase().startsWith(q));
    if (matches.length === 0) {
      console.error(chalk.red(`No live session matching "${id}".`));
      process.exitCode = 1;
      return;
    }
    if (matches.length > 1) {
      console.error(chalk.red(`"${id}" is ambiguous (${matches.length} matches). Use more of the id.`));
      process.exitCode = 1;
      return;
    }
    await jumpTo(matches[0], self);
    return;
  }

  if (!isInteractiveTerminal()) {
    console.error(chalk.red('go needs an interactive terminal, or pass a session id.'));
    process.exitCode = 1;
    return;
  }

  const target = await pickLiveTarget(activeById, self, 'Jump to a live session:', 'jump');
  if (!target) return;
  await jumpTo(target, self);
}

/**
 * Map each live session to its rich SessionMeta (worktree/PR/changes/tools/tests
 * via the shared picker), reusing `discoverSessions`. Remote or unindexed live
 * sessions get a minimal synthesized meta so they still appear and jump.
 */
export async function buildLivePool(activeById: Map<string, ActiveSession>, self: string): Promise<SessionMeta[]> {
  let metas: SessionMeta[] = [];
  try {
    metas = await discoverSessions({ all: true, since: '30d', limit: 1000 });
  } catch { /* fall back to synthesized metas */ }
  const byId = new Map<string, SessionMeta>();
  for (const m of metas) byId.set(m.id, m);
  const pool: SessionMeta[] = [];
  for (const [sid, s] of activeById) {
    pool.push(byId.get(sid) ?? synthMeta(s, self));
  }
  return mergeLocalFirst(pool, self);
}

function synthMeta(s: ActiveSession, self: string): SessionMeta {
  const remote = !!s.machine && s.machine !== self;
  // For a local session, locate the real transcript on disk so the picker's
  // buildPreview parses it directly (rich Prompt/Changes/Tools/Last response) —
  // independent of the sessions DB. Remote transcripts live on the peer, so leave
  // filePath empty and the preview shows a clean "not indexed here" note.
  const filePath = remote ? '' : (findSessionFileForKind(s.kind, s.cwd, s.sessionId) ?? '');
  return {
    id: s.sessionId!,
    shortId: s.sessionId!.slice(0, 8),
    agent: s.kind as SessionAgentId,
    timestamp: new Date(s.startedAtMs ?? Date.now()).toISOString(),
    filePath,
    cwd: s.cwd,
    project: s.cwd ? path.basename(s.cwd) : undefined,
    topic: s.topic,
    machine: s.machine,
    _remote: remote,
  };
}

// ---------- the jump ----------

export interface Where { label: string; action: string; }

function shortId(s: ActiveSession): string {
  return (s.sessionId ?? '').slice(0, 8) || '-';
}

/**
 * Pure, testable mirror of `jumpTo`'s path selection (jumpTo itself has side
 * effects — process.exit / ssh / osascript). Keep the branch ORDER in sync with
 * `jumpTo` below: remote-tmux, then local-tmux, then ghostty, then refuse.
 */
export function describeWhere(s: ActiveSession, self: string): Where {
  const remote = s.machine && s.machine !== self ? s.machine : undefined;
  const mux = s.provenance?.mux;
  if (mux?.kind === 'tmux' && mux.pane) {
    return remote
      ? { label: `tmux ${mux.pane} on ${remote}`, action: `ssh + attach on ${remote}` }
      : { label: `tmux ${mux.pane}`, action: 'attach its tmux' };
  }
  if (!remote && s.host === 'ghostty') return { label: 'Ghostty', action: 'focus its Ghostty tab' };
  if (remote) return { label: `${s.host ?? 'shell'} on ${remote}`, action: `open a shell on ${remote}` };
  return { label: s.host ?? 'unknown terminal', action: 'resume it (no live attach rail)' };
}

/**
 * What to do when a session can't be *attached* (no tmux/Ghostty rail). `go`
 * refuses; `focus` opens a new tab and resumes. `remote` is the peer name when
 * the session lives on another machine, else undefined.
 */
export type UnreachableFallback = (s: ActiveSession, remote: string | undefined) => void | Promise<void>;

/** Default (used by `go`): open a login shell on the remote, or refuse locally. */
async function refuseFallback(s: ActiveSession, remote: string | undefined): Promise<void> {
  if (remote) {
    console.log(chalk.yellow(`${shortId(s)} on ${remote} isn't inside tmux — opening a shell on ${remote} instead.`));
    assertValidSshTarget(remote);
    process.exit(sshStream(remote, 'exec "${SHELL:-/bin/sh}" -l', { tty: true }));
  }
  console.log(
    chalk.yellow(`Can't jump to ${shortId(s)} — it's in ${s.host ?? 'an unknown terminal'} with no attach rail (not tmux/Ghostty).`) +
      chalk.gray(`\nTry: agents sessions resume ${shortId(s)}`),
  );
}

export async function jumpTo(s: ActiveSession, self: string, fallback: UnreachableFallback = refuseFallback): Promise<void> {
  const remote = s.machine && s.machine !== self ? s.machine : undefined;
  const mux = s.provenance?.mux;

  // Path C: remote tmux — ssh in and attach, resolving the pane's session on the remote.
  if (remote) {
    if (mux?.kind === 'tmux' && mux.pane) {
      assertValidSshTarget(remote);
      const sock = mux.socket ? `-S ${shellQuote(mux.socket)} ` : '';
      const p = shellQuote(mux.pane);
      const remoteCmd =
        `w=$(tmux ${sock}display-message -pt ${p} '#{session_name}:#{window_index}' 2>/dev/null); ` +
        `sess=$(tmux ${sock}display-message -pt ${p} '#{session_name}' 2>/dev/null); ` +
        `[ -n "$w" ] && tmux ${sock}select-window -t "$w" 2>/dev/null; ` +
        `exec tmux ${sock}attach-session -t "\${sess:-${p}}"`;
      console.log(chalk.gray(`Attaching ${shortId(s)} on ${remote} over SSH — Ctrl-b d to detach.`));
      process.exit(sshStream(remote, remoteCmd, { tty: true }));
    }
    // Remote, not in tmux → hand off to the fallback (go: shell; focus: resume in a tab).
    await fallback(s, remote);
    return;
  }

  // Path B: local tmux — attach (or switch-client if we're already inside tmux).
  if (mux?.kind === 'tmux' && mux.pane) {
    const socket = mux.socket ?? getDefaultSocketPath();
    const { session, window } = await resolveLocalPane(socket, mux.pane);
    if (session && window != null) {
      await runTmux({ socket, args: ['select-window', '-t', `${session}:${window}`], throwOnError: false }).catch(() => {});
    }
    const tgt = session ?? mux.pane;
    if (process.env.TMUX) {
      await runTmux({ socket, args: ['switch-client', '-t', tgt], throwOnError: false }).catch(() => {});
      console.log(chalk.gray(`Switched this tmux client to ${shortId(s)} (${tgt}).`));
      return;
    }
    console.log(chalk.gray(`Attaching ${shortId(s)} (tmux ${tgt}) — Ctrl-b d to detach.`));
    process.exit(await attachTmux({ socket, args: ['attach-session', '-t', tgt] }));
  }

  // Path A: local Ghostty — focus its tab (Cmd+N via System Events).
  if (s.host === 'ghostty') {
    let tab: number | undefined;
    try {
      const surfaces = await enumerateGhosttyTabs();
      tab = assignGhosttyTabs([s], surfaces).get(s);
    } catch { /* best-effort */ }
    if (tab != null && tab <= 9) {
      const script =
        `tell application "Ghostty" to activate\n` +
        `delay 0.15\n` +
        `tell application "System Events" to keystroke "${tab}" using command down`;
      await execFileAsync('osascript', ['-e', script]).catch(() => {});
      console.log(chalk.gray(`Focused ${shortId(s)} → Ghostty tab ${tab}.`));
      return;
    }
    await execFileAsync('osascript', ['-e', 'tell application "Ghostty" to activate']).catch(() => {});
    console.log(
      chalk.yellow(`Raised Ghostty for ${shortId(s)}`) +
        chalk.gray(tab != null ? ` — switch to tab ${tab} (Cmd+${tab}).` : " — couldn't pinpoint its tab (same-repo forks are ambiguous); switch tabs manually."),
    );
    return;
  }

  // Path D: no attach rail (headless / plain terminal) → hand off to the fallback.
  await fallback(s, undefined);
}

/** Resolve a local tmux pane id to its session name + window index. */
async function resolveLocalPane(socket: string, pane: string): Promise<{ session?: string; window?: number }> {
  try {
    const res = await runTmux({ socket, args: ['display-message', '-pt', pane, '-p', '#{session_name}\t#{window_index}'], throwOnError: false });
    if (res.code !== 0) return {};
    const [session, win] = res.stdout.trim().split('\t');
    const window = Number.parseInt(win, 10);
    return { session: session || undefined, window: Number.isFinite(window) ? window : undefined };
  } catch {
    return {};
  }
}
