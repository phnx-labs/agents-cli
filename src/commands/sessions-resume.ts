/**
 * `agents sessions resume` — multi-select sessions and fan each one out into a
 * terminal surface via the terminal launch engine (src/lib/terminal).
 *
 * Unlike the single-select picker behind bare `agents sessions` (which resumes
 * one session in place), this opens a checkbox picker, then asks where the
 * chosen sessions should resume. By default they pack two-per-tab (session 1 in
 * a new tab, session 2 split beside it, session 3 a new tab, …) in the terminal
 * you're in — iTerm / Ghostty / tmux, locally or on a remote host via --host.
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
  filterSessionsByQuery,
  formatPickerLabel,
  pickerColumnsFor,
  buildResumeCommand,
  resumeSessionInPlace,
  parseAgentFilter,
} from './sessions.js';
import {
  openSurfaces,
  availableBackends,
  detectCurrentBackend,
  currentContext,
  type Backend,
  type SurfaceItem,
  type EngineContext,
} from '../lib/terminal/index.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { confirm } from '@inquirer/prompts';

/** Opening more than this many live sessions at once asks for confirmation first. */
const CONFIRM_THRESHOLD = 5;

interface ResumeOptions {
  agent?: string;
  all?: boolean;
  teams?: boolean;
  since?: string;
  limit?: string;
  host?: string;
  iterm?: boolean;
  ghostty?: boolean;
  tmux?: boolean;
  tabs?: boolean;
}

export function registerSessionsResumeCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('resume')
    .argument('[query]', 'Filter sessions before selecting (topic, path, or id fragment)')
    .description('Multi-select sessions and resume each in a terminal tab/split (this terminal, iTerm, Ghostty, tmux; local or --host).')
    .option('-a, --agent <agent>', 'Filter by agent type and version (e.g., claude, codex@0.116.0)')
    .option('--all', 'Include sessions from every directory (not just current project)')
    .option('--teams', 'Include team-spawned sessions (hidden by default)')
    .option('--since <time>', 'Only sessions newer than this (e.g., 2h, 7d, 4w, or ISO date)')
    .option('-n, --limit <n>', 'Maximum number of sessions to load into the picker', '200')
    .option('--host <alias>', 'Resume on a remote host over SSH (defaults to tmux there)')
    .option('--iterm', 'Force the iTerm backend')
    .option('--ghostty', 'Force the Ghostty backend')
    .option('--tmux', 'Force the tmux backend')
    .option('--tabs', 'One tab per session (default: pack two panes per tab)');

  setHelpSections(cmd, {
    examples: `
      # Pick several sessions; they pack two-per-tab in your current terminal
      agents sessions resume

      # Pre-filter the pool before selecting (space in the filter → use [query])
      agents sessions resume "auth middleware"

      # Force a backend / one tab each / a remote host
      agents sessions resume --ghostty
      agents sessions resume --tabs
      agents sessions resume --host zion --tmux
    `,
    notes: `
      - space toggles a session, enter confirms; tab toggles the preview pane.
      - Layout: two-per-tab by default (session 1 → new tab, session 2 → split beside it, …). --tabs disables splitting.
      - Backend: auto-detected from the terminal you're in (iTerm / Ghostty / tmux); override with --iterm/--ghostty/--tmux.
      - --host <alias> resumes on a remote machine over the same SSH transport as 'sessions --host' (defaults to tmux).
      - Each session opens version-pinned, in its own cwd. Non-resumable agents are skipped with a note.
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

  // 1. Multi-select the sessions.
  const cols = pickerColumnsFor(sessions);
  let chosen: SessionMeta[] | null;
  try {
    chosen = await multiItemPicker<SessionMeta>({
      message: 'Select sessions to resume:',
      items: sessions,
      filter: (q: string) => (q.trim() ? filterSessionsByQuery(sessions, q) : sessions),
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

  // 2. Split the selection into resumable surfaces and skipped agents (no silent drop).
  const items: Array<SurfaceItem & { session: SessionMeta }> = [];
  for (const s of chosen) {
    const command = buildResumeCommand(s);
    if (!command) {
      console.log(chalk.yellow(`  skip ${s.shortId} — resume is not supported for ${s.agent} sessions yet`));
      continue;
    }
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
    items.push({ session: s, cwd, command });
  }
  if (items.length === 0) {
    console.log(chalk.gray('Nothing resumable in the selection.'));
    return;
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

  // 5b. Fan out through the engine (two-per-tab by default).
  const packing = options.tabs ? 'tabs' : 'two-per-tab';
  const where = options.host ? `${backend} on ${options.host}` : backend;
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

/**
 * Decide which backend to launch into. Returns a concrete backend, `'inplace'`
 * (resume in the current process — no GUI/tmux available), or `'cancel'` (the
 * user dismissed the chooser).
 */
async function resolveBackend(
  options: ResumeOptions,
  ctx: EngineContext,
  count: number,
): Promise<Backend | 'inplace' | 'cancel'> {
  const forced: Backend | undefined =
    options.iterm ? 'iterm' : options.ghostty ? 'ghostty' : options.tmux ? 'tmux' : undefined;
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
