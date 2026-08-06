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
import { confirm } from '@inquirer/prompts';
import { gatherLiveTargets, pickLiveTarget, pickLiveTargets, jumpTo, refuseFallback, type UnreachableFallback } from './go.js';
import type { ActiveSession } from '../lib/session/active.js';
import type { SessionMeta, SessionAgentId } from '../lib/session/types.js';
import { requestedLiveStatuses, resolveSessionMetadataValue, type LiveStatusFilter } from './sessions.js';
import { resolveBackend, CONFIRM_THRESHOLD, resumeSelectorInPlace } from './sessions-resume.js';
import { discoverSessions } from '../lib/session/discover.js';
import { shellQuote, assertValidSshTarget } from '../lib/ssh-exec.js';
import {
  openSurfaces,
  currentContext,
  availableBackends,
  detectCurrentBackend,
  type Backend,
} from '../lib/terminal/index.js';
import { isInteractiveTerminal } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { buildCanonicalResumeCommand } from '../lib/session/resume-command.js';

/** Options for `sessions focus` — device/host scope + the `--active` live-state filters. */
export interface FocusOptions {
  local?: boolean;
  attachOnly?: boolean;
  host?: string[];
  device?: string[];
  working?: boolean;
  idle?: boolean;
  waiting?: boolean;
  orphan?: boolean;
  orphaned?: boolean;
  crashed?: boolean;
  closed?: boolean;
  abandoned?: boolean;
  queued?: boolean;
  unknown?: boolean;
}

/** `--device` is an alias of `--host`; both are repeatable. Merge into one host list. */
export function mergeFocusHosts(opts: FocusOptions): string[] {
  return [...(opts.host ?? []), ...(opts.device ?? [])];
}

/** Picker header that reflects the active filter + device, e.g. "Focus orphaned sessions on yosemite-s0:". */
export function focusHeader(statuses: LiveStatusFilter[], hosts: string[]): string {
  const where = hosts.length ? ` on ${hosts.join(', ')}` : '';
  if (statuses.length === 0) return `Focus a live session${where}:`;
  const word = statuses.length === 1 ? statusWord(statuses[0]) : 'filtered';
  return `Focus ${word} sessions${where}:`;
}

/** The adjective shown in the header for a single live-state filter. */
function statusWord(status: LiveStatusFilter): string {
  return status === 'orphaned' ? 'orphaned' : status;
}

export function registerFocusCommand(program: Command): void {
  const cmd = program
    .command('focus')
    .argument('[id]', 'Short/full session id to focus; omit for an interactive picker')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .option('--attach-only', 'Attach only — never open a new tab / resume a copy (the old `go` behavior)')
    .option('-H, --host <target...>', 'Scope the picker to live sessions on these devices (host alias or user@host; repeatable)')
    .option('--device <target...>', 'Alias for --host (device alias from `agents devices`; repeatable)')
    .option('--working', 'Only live sessions currently doing work')
    .option('--idle', 'Only live sessions that have stopped between turns')
    .option('--waiting', 'Only live sessions waiting on your input')
    .option('--orphan', 'Only sessions whose process outlived its terminal client')
    .option('--orphaned', 'Alias for --orphan')
    .option('--crashed', 'Only sessions whose terminal disappeared with the process')
    .option('--closed', 'Only recently observed sessions whose process exited normally')
    .option('--abandoned', 'Only sessions with no transcript progress for the abandonment window')
    .option('--queued', 'Only queued sessions that have not started running')
    .option('--unknown', 'Only sessions whose live state cannot be determined')
    .description('Focus live sessions — multi-select and open each as a tab (attach its pane, or resume a copy)')
    .action(async (id: string | undefined, opts: FocusOptions) => {
      await focusAction(id, opts);
    });

  setHelpSections(cmd, {
    examples: `
      # Jump to a live session (attach pane/tab, or open a new tab and resume)
      agents sessions focus a1b2c3d4

      # Multi-select live sessions; each opens as a tab in this terminal
      agents sessions focus

      # Scope the picker to one device's orphaned sessions
      agents sessions focus --orphan --device yosemite-s0

      # Attach only — refuse if nothing is joinable (old sessions go)
      agents sessions focus a1b2c3d4 --attach-only

      # Pick from live sessions on this machine only
      agents sessions focus --local
    `,
    notes: `
      - space toggles a session, enter opens the selected set; a single check + enter opens just one.
      - Each selected session opens as a new tab in the terminal you're in (Ghostty / iTerm / tmux, auto-detected).
      - A live tmux session is JOINED in the tab (a second client, no fork) — local or remote over SSH; a session with no attach rail resumes a copy in the tab, reported never silently dropped.
      - --host/--device scopes the pool to those devices; the live-state filters (--orphan/--crashed/…) narrow by status and compose with the device scope.
      Lifecycle siblings (not synonyms):
        focus              live jump (default "take me there")
        focus --attach-only  attach only; never fork (replaces go)
        detach / attach    interactive ↔ headless presence
        resume             multi-select history → tabs
        run --resume       single scripted continue
    `,
  });
}

/**
 * Which fallback fires when a session has no attach rail. `--attach-only` (the old
 * `go`) refuses; the default opens a new tab and resumes a copy. Pure so it's testable
 * without touching `jumpTo`'s side effects.
 */
export function selectFallback(attachOnly: boolean | undefined): UnreachableFallback {
  return attachOnly ? refuseFallback : resumeInNewTab;
}

export async function focusAction(id: string | undefined, opts: FocusOptions): Promise<void> {
  const hosts = mergeFocusHosts(opts);
  const statuses = requestedLiveStatuses(opts);
  // A device scope needs the cross-host sweep; --local only wins when no host is named.
  const local = !!opts.local && hosts.length === 0;
  const { self, activeById } = await gatherLiveTargets(local, { hosts, statuses });
  const fallback = selectFallback(opts.attachOnly);

  if (id) {
    const outcome = await resolveSessionMetadataValue(id.trim(), { local, hosts });
    if (outcome.kind === 'partial') {
      console.error(chalk.red(`Could not resolve session while these devices were unavailable: ${outcome.failedPeers.join(', ')}`));
      process.exitCode = 2;
      return;
    }
    if (outcome.kind === 'ambiguous') {
      console.error(chalk.red(`"${id}" matches ${outcome.candidates.length} sessions. Pass a longer id or alias.`));
      process.exitCode = 1;
      return;
    }
    if (outcome.kind === 'not-found') {
      console.error(chalk.red(`No session matching "${id}".`));
      process.exitCode = 1;
      return;
    }

    const live = activeById.get(outcome.session.id);
    if (live && isAttachableLiveSession(live)) {
      await jumpTo(live, self, fallback);
      return;
    }

    if (opts.attachOnly) {
      console.error(chalk.red(`${outcome.session.shortId} has no live terminal to attach.`));
      process.exitCode = 1;
      return;
    }

    await recoverResolvedSession(outcome.session);
    return;
  }

  if (!isInteractiveTerminal()) {
    console.error(chalk.red('focus needs an interactive terminal, or pass a session id.'));
    process.exitCode = 1;
    return;
  }
  if (activeById.size === 0) {
    const scope = describeScope(statuses, hosts);
    console.log(chalk.gray(`No live sessions to focus${scope}. To resume a past one: agents sessions resume`));
    return;
  }

  const header = focusHeader(statuses, hosts);

  // --attach-only keeps the old `go` single-jump: pick one, attach it in place (or refuse).
  if (opts.attachOnly) {
    const target = await pickLiveTarget(activeById, self, header, 'focus');
    if (!target) return;
    await jumpTo(target, self, fallback);
    return;
  }

  // Default: multi-select → open each selected session as a tab in this terminal.
  const targets = await pickLiveTargets(activeById, self, header);
  if (targets.length === 0) return;
  await openFocusTabs(targets, self);
}

/** A retained pane is not attachable merely because tmux can still display it. */
export function isAttachableLiveSession(session: ActiveSession): boolean {
  return session.pidAlive !== false && session.status !== 'closed' && session.status !== 'crashed';
}

async function recoverResolvedSession(session: SessionMeta): Promise<void> {
  const command = buildCanonicalResumeCommand(session.id);
  const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();
  const ctx = currentContext();
  const backend: Backend | undefined = detectCurrentBackend(ctx) ?? availableBackends(ctx)[0]?.id;
  if (!backend) {
    await resumeSelectorInPlace(session.id);
    return;
  }
  console.log(chalk.gray(`${session.shortId} is not live — opening a ${backend} tab and resuming it.`));
  const [result] = await openSurfaces([{ cwd, command }], { backend, packing: 'tabs' });
  if (!result?.ok) {
    console.error(chalk.red(`Failed to open ${session.shortId}: ${result?.error ?? 'unknown error'}`));
    process.exitCode = 1;
  }
}

/** Human scope suffix for the empty-pool message, e.g. " (orphaned on yosemite-s0)". */
function describeScope(statuses: LiveStatusFilter[], hosts: string[]): string {
  const parts: string[] = [];
  if (statuses.length) parts.push(statuses.map(statusWord).join('/'));
  if (hosts.length) parts.push(`on ${hosts.join(', ')}`);
  return parts.length ? ` (${parts.join(' ')})` : '';
}

/**
 * How a single selected live session opens in its new tab.
 *  - `attach` — a live tmux pane joined in the tab (a second client, no fork),
 *    local (`sh -c`) or remote (`ssh -tt`). tmux is the only rail that can be
 *    *joined* without forking (see the file header).
 *  - `resume` — no attach rail, so resume a copy in the tab (the original keeps
 *    running); never a silent drop.
 *  - `skip` — not resumable AND no rail: reported, not dropped.
 */
export type FocusSurfacePlan =
  | { kind: 'attach'; command: string[]; note: string }
  | { kind: 'resume'; command: string[]; note: string }
  | { kind: 'skip'; note: string };

/**
 * Shell that resolves a tmux pane to its session and attaches it — the exact form
 * `jumpTo` uses, minus the pre-select-window nicety, so a batch tab joins the live
 * session (a second client) without forking. Reused for local and (wrapped in ssh)
 * remote panes.
 */
export function tmuxAttachScript(mux: { socket?: string; pane: string }): string {
  const sock = mux.socket ? `-S ${shellQuote(mux.socket)} ` : '';
  const p = shellQuote(mux.pane);
  return (
    `sess=$(tmux ${sock}display-message -pt ${p} '#{session_name}' 2>/dev/null); ` +
    `exec tmux ${sock}attach-session -t "\${sess:-${p}}"`
  );
}

/**
 * Decide how one live session opens as a tab. Pure over the session + a
 * `resumeCommandFor` resolver (injected so the local version-pinned resume command
 * and the tests stay decoupled from `discoverSessions`).
 */
export function planFocusSurface(
  s: ActiveSession,
  self: string,
  resumeCommandFor: (s: ActiveSession) => string[] | null,
): FocusSurfacePlan {
  const remote = s.machine && s.machine !== self ? s.machine : undefined;
  const mux = s.provenance?.mux;
  const sid = shortId(s);

  // Join rail = tmux only (local or remote over SSH). A new tab attaching the live
  // tmux session is a second client: join, no fork.
  if (mux?.kind === 'tmux' && mux.pane) {
    const script = tmuxAttachScript({ socket: mux.socket, pane: mux.pane });
    if (remote) {
      assertValidSshTarget(remote);
      return {
        kind: 'attach',
        command: ['ssh', '-tt', remote, shellQuote(script)],
        note: `attach ${mux.pane} on ${remote}`,
      };
    }
    return { kind: 'attach', command: ['sh', '-c', shellQuote(script)], note: `attach ${mux.pane}` };
  }

  // No join rail → the canonical command resolves the owner device itself.
  const cmd = resumeCommandFor(s);
  if (!cmd) return { kind: 'skip', note: `${sid} — ${s.kind} sessions can't be resumed, and it has no live tmux to join` };
  return { kind: 'resume', command: cmd, note: 'resume a copy (no live tmux to join)' };
}

/** The engine seam — real `openSurfaces`, overridable in tests to assert the tab requests. */
export type OpenSurfacesFn = typeof openSurfaces;

/** Test seams for `openFocusTabs`: inject the engine boundary + force a backend. */
export interface OpenFocusTabsDeps {
  open?: OpenSurfacesFn;
  /** Skip `resolveBackend` (which needs a live terminal) when set — tests pass 'tmux'. */
  backend?: Backend | 'inplace';
}

/**
 * Open each selected live session as a tab: attach its live pane where one exists,
 * else resume a copy. Reuses `resume`'s backend resolution + flood guard.
 */
export async function openFocusTabs(
  targets: ActiveSession[],
  self: string,
  deps: OpenFocusTabsDeps = {},
): Promise<void> {
  const open = deps.open ?? openSurfaces;
  // The canonical resume command resolves metadata itself; active cwd is enough
  // to place the terminal without another transcript scan.
  const byId = new Map<string, SessionMeta>();
  const resumeCommandFor = (s: ActiveSession): string[] | null =>
    s.sessionId ? buildCanonicalResumeCommand(s.sessionId) : null;

  const planned = targets.map((s) => ({ s, plan: planFocusSurface(s, self, resumeCommandFor) }));

  // Skips are reported, never silently dropped.
  for (const p of planned) if (p.plan.kind === 'skip') console.log(chalk.yellow(`  skip ${p.plan.note}`));
  const openable = planned.filter((p): p is { s: ActiveSession; plan: Exclude<FocusSurfacePlan, { kind: 'skip' }> } => p.plan.kind !== 'skip');
  if (openable.length === 0) {
    console.log(chalk.gray('Nothing to open in the selection.'));
    return;
  }

  const backend = deps.backend ?? (await resolveBackend({}, currentContext(), openable.length));
  if (backend === 'cancel') return;

  // Guard against opening a flood of live agents at once.
  if (openable.length > CONFIRM_THRESHOLD) {
    const proceed = await confirm({ message: `Open ${openable.length} sessions at once?`, default: false }).catch(() => false);
    if (!proceed) return;
  }

  // No tab-capable terminal (off-macOS, not in tmux): fall back to the single
  // foreground jump for the first, and say the rest need a tab-capable terminal.
  if (backend === 'inplace') {
    if (openable.length > 1) {
      console.log(chalk.yellow(`This terminal can't open tabs — jumping to the first; open in Ghostty/iTerm/tmux to focus several at once.`));
    }
    await jumpTo(openable[0].s, self, selectFallback(false));
    return;
  }

  console.log(chalk.gray(`Opening ${openable.length} session${openable.length === 1 ? '' : 's'} in ${backend} (tabs)…`));
  const results = await open(
    openable.map((p) => ({ cwd: cwdFor(p.s, byId), command: p.plan.command })),
    { backend, packing: 'tabs' },
  );
  let opened = 0;
  results.forEach((r, i) => {
    const p = openable[i];
    if (r.ok) {
      opened++;
      console.log(chalk.green(`  opened ${shortId(p.s)}`) + chalk.gray(` — tab — (${p.plan.note})`));
    } else {
      console.log(chalk.red(`  failed ${shortId(p.s)} — ${r.error}`));
    }
  });
  console.log(chalk.gray(`\nOpened ${opened}/${openable.length} in ${backend}.`));
}

/** A real cwd for the tab: the session's indexed cwd if it still exists, else here. */
function cwdFor(s: ActiveSession, byId: Map<string, SessionMeta>): string {
  const cwd = byId.get(s.sessionId ?? '')?.cwd ?? s.cwd;
  return cwd && fs.existsSync(cwd) ? cwd : process.cwd();
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
const resumeInNewTab: UnreachableFallback = async (s) => {
  const id = s.sessionId ?? '';
  if (!id) {
    console.log(chalk.yellow('This session has no id to resume.'));
    return;
  }

  // The canonical command resolves the source device and pinned launch metadata.
  const meta = (await richMetaById(id)) ?? metaFromActive(s);
  const command = buildCanonicalResumeCommand(meta.id);
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd();

  const ctx = currentContext();
  const backend: Backend | undefined = detectCurrentBackend(ctx) ?? availableBackends(ctx)[0]?.id;
  if (!backend) {
    // No tab-capable surface (off-macOS, not in tmux) — resume in this process.
    await resumeSelectorInPlace(meta.id);
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
