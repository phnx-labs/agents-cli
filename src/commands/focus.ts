/**
 * `agents sessions focus [id]` — take me to a live session, however it's reachable.
 *
 * Same detection as `go`, but where `go` *refuses* an un-attachable session,
 * `focus` **opens a new tab and resumes it** — locally, or on the remote over SSH
 * (via the terminal launch engine's `openSurfaces`, `host` = the peer). So:
 *   - in tmux (local/remote)   -> attach the live pane (join it, no fork)
 *   - in Ghostty               -> focus its tab
 *   - headless / plain / etc.  -> new tab + `resume` (a copy if it's mid-run — the
 *                                  original keeps going; a clean continue if it's idle)
 *
 * NOTE: joining a live process without forking is only possible via tmux — that's
 * why `--tmux`-wrapped launches are worth it for sessions you'll want back live.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import chalk from 'chalk';
import { gatherLiveTargets, pickLiveTarget, jumpTo, type UnreachableFallback } from './go.js';
import type { ActiveSession } from '../lib/session/active.js';
import type { SessionMeta, SessionAgentId } from '../lib/session/types.js';
import { buildResumeCommand, resumeSessionInPlace } from './sessions.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { discoverSessions } from '../lib/session/discover.js';
import {
  openSurfaces,
  currentContext,
  availableBackends,
  detectCurrentBackend,
  type Backend,
} from '../lib/terminal/index.js';
import { isInteractiveTerminal } from './utils.js';

export function registerFocusCommand(program: Command): void {
  program
    .command('focus')
    .argument('[id]', 'Short/full session id to focus; omit for an interactive picker')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .description('Focus a live session — attach its terminal, or open a new tab and resume it')
    .action(async (id: string | undefined, opts: { local?: boolean }) => {
      await focusAction(id, opts);
    });
}

async function focusAction(id: string | undefined, opts: { local?: boolean }): Promise<void> {
  const { self, activeById } = await gatherLiveTargets(!!opts.local);

  if (id) {
    const q = id.toLowerCase();
    const matches = [...activeById.values()].filter((s) => s.sessionId!.toLowerCase().startsWith(q));
    if (matches.length === 1) {
      await jumpTo(matches[0], self, resumeInNewTab);
      return;
    }
    if (matches.length > 1) {
      console.error(chalk.red(`"${id}" is ambiguous (${matches.length} live matches). Use more of the id.`));
      process.exitCode = 1;
      return;
    }
    // Not live — it's a past session; resume is the right tool (multi-select + placement).
    console.log(
      chalk.yellow(`No live session matching "${id}".`) +
        chalk.gray(`\nTo resume a past session: agents sessions resume ${id}`),
    );
    process.exitCode = 1;
    return;
  }

  if (!isInteractiveTerminal()) {
    console.error(chalk.red('focus needs an interactive terminal, or pass a session id.'));
    process.exitCode = 1;
    return;
  }
  if (activeById.size === 0) {
    console.log(chalk.gray('No live sessions to focus. To resume a past one: agents sessions resume'));
    return;
  }
  const target = await pickLiveTarget(activeById, self, 'Focus a live session:', 'focus');
  if (!target) return;
  await jumpTo(target, self, resumeInNewTab);
}

function shortId(s: ActiveSession): string {
  return (s.sessionId ?? '').slice(0, 8) || '-';
}

/** Minimal SessionMeta for a live session, enough for `buildResumeCommand` + placement. */
export function metaFromActive(s: ActiveSession): SessionMeta {
  return {
    id: s.sessionId ?? '',
    shortId: shortId(s),
    agent: s.kind as SessionAgentId,
    timestamp: new Date(s.startedAtMs ?? Date.now()).toISOString(),
    filePath: '',
    cwd: s.cwd,
  };
}

/** Look up the rich indexed SessionMeta by id so `version` survives (version-pinned resume). */
async function richMetaById(id: string): Promise<SessionMeta | undefined> {
  try {
    const metas = await discoverSessions({ all: true, since: '90d', limit: 2000 });
    return metas.find((m) => m.id === id) ?? metas.find((m) => m.id.startsWith(id));
  } catch {
    return undefined;
  }
}

/**
 * `focus`'s fallback for a session with no attach rail: reopen it and hand you to it.
 *   - remote → resume ON the peer over SSH (foreground) — the peer resolves the pinned
 *              version and holds the transcript, and `-tt` delivers you there.
 *   - local  → resume in a new tab in your terminal, version-pinned via the indexed meta.
 * Note: for a session that's still mid-run, this opens a COPY (the original keeps going);
 * only tmux can *join* a live one without forking (see the header).
 */
const resumeInNewTab: UnreachableFallback = async (s, remote) => {
  const id = s.sessionId ?? '';
  if (!id) {
    console.log(chalk.yellow('This session has no id to resume.'));
    return;
  }

  // Remote: the transcript + pinned version live on the peer, so resume THERE over SSH.
  // runOnPeer runs `agents sessions resume <id>` with a real TTY (`-tt`) in the foreground —
  // it actually delivers you to the session (the peer picks the right version + HOME).
  if (remote) {
    console.log(chalk.gray(`${shortId(s)} has no live terminal on ${remote} — resuming it there over SSH…`));
    const rc = await runOnPeer(['sessions', 'resume', id], remote, { tty: true });
    if (rc === 'no-target') {
      console.log(chalk.red(`${remote} isn't reachable as a device. Try: agents devices sync`));
      console.log(chalk.gray(`  or run it yourself: ssh ${remote} 'agents sessions resume ${shortId(s)}'`));
    }
    return;
  }

  // Local: resume in a new tab. Use the indexed meta so the version-pinned binary
  // resumes in the same isolated HOME the transcript was written in.
  const meta = (await richMetaById(id)) ?? metaFromActive(s);
  const command = buildResumeCommand(meta);
  if (!command) {
    console.log(chalk.yellow(`${meta.shortId} — ${meta.agent} sessions aren't resumable, so there's no way to reopen it.`));
    return;
  }
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd();

  const ctx = currentContext();
  const backend: Backend | undefined = detectCurrentBackend(ctx) ?? availableBackends(ctx)[0]?.id;
  if (!backend) {
    // No tab-capable surface (off-macOS, not in tmux) — resume in this process.
    await resumeSessionInPlace(meta);
    return;
  }

  console.log(chalk.gray(`${shortId(s)} has no live terminal to attach — opening a new ${backend} tab and resuming a copy.`));
  const results = await openSurfaces([{ cwd, command }], { backend, packing: 'tabs' });
  const r = results[0];
  if (!r || !r.ok) {
    console.log(chalk.red(`  failed to open — ${r?.error ?? 'unknown error'}`));
    console.log(chalk.gray(`  try: agents sessions resume ${meta.shortId}`));
  }
};
