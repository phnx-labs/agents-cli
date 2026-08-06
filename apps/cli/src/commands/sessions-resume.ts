/**
 * `agents sessions resume` — multi-select sessions and fan each one out into a
 * terminal surface via the terminal launch engine (src/lib/terminal).
 *
 * Unlike the single-select picker behind bare `agents sessions` (which resumes
 * one session in place), this opens a checkbox picker, then asks where the
 * chosen sessions should resume. By default each session opens in its own tab in
 * the terminal you're in — iTerm / Ghostty / tmux, locally or on a remote host
 * via --host. `--splits` opts into packing two sessions side by side per tab.
 */
import * as fs from 'fs';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { SessionMeta } from '../lib/session/types.js';
import { discoverSessions } from '../lib/session/discover.js';
import { filterTeamSessions } from '../lib/session/team-filter.js';
import { multiItemPicker, itemPicker } from '../lib/picker.js';
import { buildPreview } from './sessions-picker.js';
import {
  formatPickerLabel,
  pickerColumnsFor,
  buildSessionRecoveryCommand,
  resumeSessionInPlace,
  parseAgentFilter,
} from './sessions.js';
import { sessionMatchesQuery } from './sessions-browser.js';
import {
  openSurfaces,
  availableBackends,
  detectCurrentBackend,
  currentContext,
  type Backend,
  type SurfaceItem,
  type EngineContext,
  type Packing,
} from '../lib/terminal/index.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { confirm } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import { looksLikeSessionId } from '../lib/session/discover.js';
import { machineId } from '../lib/session/sync/config.js';
import { sessionOriginDevice, sessionRecoveryDestinationMatches } from '../lib/session/recovery.js';

/** Opening more than this many live sessions at once asks for confirmation first. */
export const CONFIRM_THRESHOLD = 5;

export interface ResumeOptions {
  agent?: string;
  all?: boolean;
  teams?: boolean;
  since?: string;
  limit?: string;
  host?: string;
  iterm?: boolean;
  ghostty?: boolean;
  tmux?: boolean;
  vscodium?: boolean;
  /** --terminal-app: force macOS Terminal.app. Named to avoid reading as `run --terminal`. */
  terminalApp?: boolean;
  splits?: boolean;
}

export function registerSessionsResumeCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('resume')
    .argument('[query]', 'Session id/tmux alias to reopen directly, or text that filters the picker')
    .description('Reopen one session by canonical identity, or multi-select history into terminal tabs/splits.')
    .option('-a, --agent <agent>', 'Filter by agent type and version (e.g., claude, codex@0.116.0)')
    .option('--all', 'Include sessions from every directory (not just current project)')
    .option('--teams', 'Include team-spawned sessions (hidden by default)')
    .option('--since <time>', 'Only sessions newer than this (e.g., 2h, 7d, 4w, or ISO date)')
    .option('-n, --limit <n>', 'Maximum number of sessions to load into the picker', '200')
    .option('--host <alias>', 'Open on the session origin host over SSH; the host must match every selected session')
    .option('--iterm', 'Force the iTerm backend')
    .option('--ghostty', 'Force the Ghostty backend')
    .option('--tmux', 'Force the tmux backend')
    .option('--vscodium', 'Force the VSCodium agent-terminal backend (swarm-ext)')
    .option('--terminal-app', 'Force macOS Terminal.app (no split support — panes become tabs)')
    .option('--splits', 'Pack two sessions side by side per tab (default: one tab per session)');

  setHelpSections(cmd, {
    examples: `
      # Pick several sessions; each opens in its own tab
      agents sessions resume

      # Pre-filter the pool before selecting (space in the filter → use [query])
      agents sessions resume "auth middleware"

      # Reopen one session from any device by UUID prefix or tmux alias
      agents sessions resume 019fd114
      agents sessions resume ag-codex-c1f3d813

      # Force a backend / side-by-side splits / a remote host
      agents sessions resume --ghostty
      agents sessions resume --vscodium
      agents sessions resume --splits
      agents sessions resume --host zion --tmux
    `,
    notes: `
      - A UUID/prefix or ag-<agent>-<suffix> alias bypasses the picker: a live pane is attached; an inactive session resumes on its owning device.
      - With no identity selector, space toggles a session, enter confirms, and tab toggles the preview pane.
      - Layout: one tab per session by default. --splits packs session pairs side by side in each tab.
      - Backend: auto-detected from the terminal you're in (iTerm / Ghostty / tmux); override with --iterm/--ghostty/--tmux/--vscodium.
      - --vscodium opens each session as an agent terminal tab in VSCodium via the swarm-ext extension (works with --host too).
      - --host <alias> opens the terminal surface on that host only when it is the selected sessions' origin; recovery never migrates a session to another device.
      - Recovery runs on the session's origin device: exact healthy origin uses native resume; otherwise a healthy version of the same harness receives /continue <id>.
    `,
  });

  cmd.action(async (query: string | undefined, options: ResumeOptions) => {
    await sessionsResumeAction(query, options);
  });
}

async function sessionsResumeAction(query: string | undefined, options: ResumeOptions): Promise<void> {
  if (!isInteractiveTerminal()) {
    console.error(chalk.red('sessions resume needs an interactive terminal.'));
    process.exitCode = 1;
    return;
  }

  if (query && isDirectResumeSelector(query)) {
    await dispatchSessionLifecycleInPlace(query.trim(), options.host ? [options.host] : []);
    return;
  }

  const { agent, version } = parseAgentFilter(options.agent);
  const limit = parseInt(options.limit || '200', 10);
  const since = options.since ?? (options.all ? undefined : '30d');

  let sessions = await discoverSessions({
    agent,
    version,
    all: options.all,
    cwd: process.cwd(),
    since,
    sortBy: 'timestamp',
    limit,
    excludeTeamOrigin: !options.teams,
  });
  const { visible } = filterTeamSessions(sessions, !!options.teams);
  sessions = visible;

  if (sessions.length === 0) {
    console.log(chalk.gray('No sessions found. Try --all or a different --since window.'));
    return;
  }

  // 1. Multi-select the sessions. gutter: 6 = the multi-select cursor + checkbox
  // ('> [x] ') that multiItemPicker prepends, so rows size to fit without wrapping.
  const cols = { ...pickerColumnsFor(sessions), gutter: 6 };
  let chosen: SessionMeta[] | null;
  try {
    chosen = await multiItemPicker<SessionMeta>({
      message: 'Select sessions to resume:',
      items: sessions,
      filter: (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions),
      labelFor: (s, q) => formatPickerLabel(s, q, cols),
      keyFor: (s) => s.id,
      buildPreview,
      pageSize: 15,
      initialSearch: query,
      emptyMessage: 'No sessions match.',
      enterHint: 'resume',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return;
    throw err;
  }
  if (!chosen || chosen.length === 0) return;

  if (options.host) {
    const requestedHost = options.host;
    const mismatches = chosen
      .map((session) => resumeHostMismatch(session, requestedHost))
      .filter((message): message is string => message !== null);
    if (mismatches.length > 0) {
      for (const message of mismatches) console.error(chalk.red(message));
      process.exitCode = 1;
      return;
    }
  }

  // 2. Route every selection through the owning device's recovery resolver.
  const items: Array<SurfaceItem & { session: SessionMeta }> = [];
  for (const s of chosen) {
    const command = buildSessionRecoveryCommand(s, !!options.host);
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
    items.push({ session: s, cwd, command });
  }

  // 3. Resolve the backend (and host).
  const ctx = currentContext();
  const backend = await resolveBackend(options, ctx, items.length);
  if (backend === 'cancel') return;

  // 4. Guard against opening a flood of live agents.
  if (items.length > CONFIRM_THRESHOLD) {
    const proceed = await confirm({
      message: `Open ${items.length} live sessions at once?`,
      default: false,
    }).catch(() => false);
    if (!proceed) return;
  }

  // 5a. No tab-capable backend (off-macOS, not in tmux, local) — resume in place, sequentially.
  if (backend === 'inplace') {
    if (items.length > 1) {
      console.log(chalk.gray(`Resuming ${items.length} sessions one at a time (no tab-capable terminal detected).`));
    }
    for (const it of items) await resumeSessionInPlace(it.session);
    return;
  }

  // 5b. Fan out through the engine. Full-width tabs are the default for batch
  // recovery; callers can explicitly opt into pairs of side-by-side panes.
  const packing = resolveResumePacking(options);
  const where = options.host ? `${backend} on ${options.host}` : backend;
  // Terminal.app has no scriptable split, so its buildSplit opens a tab. Say so
  // when the user actually asked for panes — the layout silently not happening
  // is worse than one line of warning.
  if (backend === 'terminal' && packing === 'two-per-tab') {
    console.log(chalk.yellow('Terminal.app cannot split panes — opening one tab per session instead.'));
  }
  console.log(chalk.gray(`Opening ${items.length} session${items.length === 1 ? '' : 's'} in ${where} (${packing})…`));

  const results = await openSurfaces(
    items.map((it) => ({ cwd: it.cwd, command: it.command })),
    { backend, host: options.host, packing },
  );

  let opened = 0;
  results.forEach((r, i) => {
    const s = items[i].session;
    if (r.ok) {
      opened++;
      const shape = r.request.layout === 'tab' ? 'tab' : 'split';
      console.log(chalk.green(`  opened ${s.shortId}`) + chalk.gray(` — ${shape} — ${items[i].command.join(' ')}`));
    } else {
      console.log(chalk.red(`  failed ${s.shortId} — ${r.error}`));
    }
  });
  console.log(chalk.gray(`\nOpened ${opened}/${items.length} in ${where}.`));
}

/** IDs and tmux aliases are actions, not picker search text. Human phrases keep
 * the existing pre-filtered picker, while an explicit identity resumes directly. */
export function isDirectResumeSelector(query: string): boolean {
  const selector = query.trim();
  return looksLikeSessionId(selector) || /^ag-[a-z][a-z0-9-]*-[0-9a-f]{8}$/i.test(selector);
}

/** Re-enter through the top-level command so fleet routing and harness policy
 * stay centralized. The child inherits this terminal for a real interactive resume. */
export async function resumeSelectorInPlace(selector: string): Promise<void> {
  await spawnCliInPlace(['resume', selector]);
}

/** Direct identities use focus as the lifecycle dispatcher: it rechecks the
 * live fleet, attaches a healthy pane, and falls through to `agents resume`
 * only when the process is no longer attachable. */
export async function dispatchSessionLifecycleInPlace(selector: string, hosts: string[] = []): Promise<void> {
  await spawnCliInPlace(buildSessionLifecycleArgs(selector, hosts));
}

export function buildSessionLifecycleArgs(selector: string, hosts: string[] = []): string[] {
  return ['sessions', 'focus', selector, ...hosts.flatMap(host => ['--host', host])];
}

function asyncExitCode(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function spawnCliInPlace(args: string[]): Promise<void> {
  const child = spawn(process.execPath, [process.argv[1], ...args], { stdio: 'inherit' });
  const exitCode = await asyncExitCode(child);
  process.exitCode = exitCode;
}

export function resolveResumePacking(options: Pick<ResumeOptions, 'splits'>): Packing {
  return options.splits ? 'two-per-tab' : 'tabs';
}

export function resumeHostMismatch(
  session: Pick<SessionMeta, 'shortId' | 'machine'>,
  requestedHost: string,
  self = machineId(),
): string | null {
  const origin = sessionOriginDevice(session, self);
  return sessionRecoveryDestinationMatches(session, requestedHost, self)
    ? null
    : `Session ${session.shortId} originated on ${origin}; --host ${requestedHost} cannot move recovery to another device.`;
}

/**
 * Decide which backend to launch into. Returns a concrete backend, `'inplace'`
 * (resume in the current process — no GUI/tmux available), or `'cancel'` (the
 * user dismissed the chooser).
 */
export async function resolveBackend(
  options: ResumeOptions,
  ctx: EngineContext,
  count: number,
): Promise<Backend | 'inplace' | 'cancel'> {
  const forced: Backend | undefined =
    options.iterm ? 'iterm'
      : options.ghostty ? 'ghostty'
      : options.tmux ? 'tmux'
      : options.vscodium ? 'vscodium-agent'
      : options.terminalApp ? 'terminal'
      : undefined;
  if (forced) return forced;
  // Remote defaults to tmux (headless, no GUI session assumptions); override with a backend flag.
  if (options.host) return 'tmux';

  const available = availableBackends(ctx);
  if (available.length === 0) return 'inplace';

  const detected = detectCurrentBackend(ctx);
  // Only one option and it's where we already are → no need to ask.
  if (available.length === 1 && (!detected || detected === available[0].id)) return available[0].id;

  interface BackendChoice { id: Backend; label: string; detail: string; }
  const choices: BackendChoice[] = available.map((b) => ({
    id: b.id,
    label: b.label,
    detail: b.id === detected ? "the terminal you're in now" : `open in ${b.label}`,
  }));
  try {
    const picked = await itemPicker<BackendChoice>({
      message: `Resume ${count} session${count === 1 ? '' : 's'} where?`,
      items: choices,
      filter: () => choices,
      labelFor: (c) => `${chalk.bold(c.label.padEnd(10))}${chalk.gray(c.detail)}`,
      shortIdFor: (c) => c.label,
      enterHint: 'open',
    });
    return picked ? picked.item.id : 'cancel';
  } catch (err) {
    if (isPromptCancelled(err)) return 'cancel';
    throw err;
  }
}
