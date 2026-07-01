/**
 * `agents sessions resume` — multi-select sessions and fan each one out into a
 * terminal tab.
 *
 * Unlike the single-select picker behind bare `agents sessions` (which resumes
 * one session in place), this opens a checkbox picker, then asks where the
 * chosen sessions should resume: a new tab in the terminal you're in now
 * (auto-detected), a new iTerm tab, or a new Ghostty tab — one tab per session.
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
  buildResumeCommand,
  resumeSessionInPlace,
  parseAgentFilter,
} from './sessions.js';
import {
  availableDestinations,
  launchResumeInTab,
  type DestinationChoice,
  type ResumeTarget,
} from '../lib/session/launch.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { confirm } from '@inquirer/prompts';

/** Opening more than this many live sessions at once asks for confirmation first. */
const CONFIRM_THRESHOLD = 5;
/** Stagger between tab launches so N tabs don't stampede the launcher. */
const STAGGER_MS = 700;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ResumeOptions {
  agent?: string;
  all?: boolean;
  teams?: boolean;
  since?: string;
  limit?: string;
}

export function registerSessionsResumeCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('resume')
    .argument('[query]', 'Filter sessions before selecting (topic, path, or id fragment)')
    .description('Multi-select sessions and resume each in a new tab (this terminal, iTerm, or Ghostty).')
    .option('-a, --agent <agent>', 'Filter by agent type and version (e.g., claude, codex@0.116.0)')
    .option('--all', 'Include sessions from every directory (not just current project)')
    .option('--teams', 'Include team-spawned sessions (hidden by default)')
    .option('--since <time>', 'Only sessions newer than this (e.g., 2h, 7d, 4w, or ISO date)')
    .option('-n, --limit <n>', 'Maximum number of sessions to load into the picker', '200');

  setHelpSections(cmd, {
    examples: `
      # Pick several sessions, choose where they resume
      agents sessions resume

      # Pre-filter the pool before selecting
      agents sessions resume "auth middleware"

      # Include every directory, not just this project
      agents sessions resume --all
    `,
    notes: `
      - space toggles a session, enter confirms; tab toggles the preview pane.
      - Destinations: "This terminal" auto-detects your emulator (iTerm / Ghostty / tmux);
        iTerm and Ghostty are offered on macOS when the app is installed.
      - Each selected session opens in its own tab, version-pinned, in its own cwd.
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
  let chosen: SessionMeta[] | null;
  try {
    chosen = await multiItemPicker<SessionMeta>({
      message: 'Select sessions to resume:',
      items: sessions,
      filter: (q: string) => (q.trim() ? filterSessionsByQuery(sessions, q) : sessions),
      labelFor: (s, q) => formatPickerLabel(s, q),
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

  // 2. Choose the destination.
  const dests = availableDestinations();
  let target: ResumeTarget;
  if (dests.length === 1) {
    target = dests[0].target;
  } else {
    let pickedDest;
    try {
      pickedDest = await itemPicker<DestinationChoice>({
        message: `Resume ${chosen.length} session${chosen.length === 1 ? '' : 's'} where?`,
        items: dests,
        filter: () => dests,
        labelFor: (d) => `${chalk.bold(d.label.padEnd(14))}${chalk.gray(d.detail)}`,
        shortIdFor: (d) => d.label,
        enterHint: 'open',
      });
    } catch (err) {
      if (isPromptCancelled(err)) return;
      throw err;
    }
    if (!pickedDest) return;
    target = pickedDest.item.target;
  }

  // 3. Guard against opening a flood of live agents.
  if (chosen.length > CONFIRM_THRESHOLD) {
    const proceed = await confirm({
      message: `Open ${chosen.length} live sessions at once?`,
      default: false,
    }).catch(() => false);
    if (!proceed) return;
  }

  // 4. Launch.
  if (target === 'inplace') {
    // No emulator we can open tabs into — resume sequentially in this terminal.
    if (chosen.length > 1) {
      console.log(chalk.gray(`Resuming ${chosen.length} sessions one at a time (no tab-capable terminal detected).`));
    }
    for (const s of chosen) {
      await resumeSessionInPlace(s);
    }
    return;
  }

  await launchTabs(chosen, target);
}

/** Open one tab per session in the chosen emulator, staggered, reporting each. */
async function launchTabs(chosen: SessionMeta[], target: Exclude<ResumeTarget, 'inplace'>): Promise<void> {
  let opened = 0;
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i];
    const resume = buildResumeCommand(s);
    if (!resume) {
      console.log(chalk.yellow(`  skip ${s.shortId} — resume is not supported for ${s.agent} sessions yet`));
      continue;
    }
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
    const res = await launchResumeInTab(target, cwd, resume);
    if (res.ok) {
      opened++;
      console.log(chalk.green(`  opened ${s.shortId}`) + chalk.gray(` — ${resume.join(' ')}  (${cwd})`));
    } else {
      console.log(chalk.red(`  failed ${s.shortId} — ${res.error}`));
    }
    if (i < chosen.length - 1) await sleep(STAGGER_MS);
  }
  console.log(chalk.gray(`\nOpened ${opened} ${target} tab${opened === 1 ? '' : 's'}.`));
}
