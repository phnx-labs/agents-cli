/**
 * `agents logs` — unified, discoverable run-log viewer.
 *
 * Resolves a run across two substrates and shows (or `-f` follows) its log:
 *  - host-dispatch tasks (`agents run --host`) → combined-stdout log, offset-tailed
 *  - sessions (the local index) → transcript, tailed via the sessions tailer
 *
 * `[id]`/`--session` load directly (host task tried first, then session). With no
 * id, `--host`/`--agent`/`--version` filter a merged candidate list; one match is
 * shown, several open the fuzzy picker (or, non-TTY, print the list).
 *
 * Additive: `agents hosts logs` and `agents sessions tail` are unchanged and share
 * the same underlying helpers (showHostTaskLog / streamSessionTail).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { SessionMeta } from '../lib/session/types.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { parseAgentFilter, renderSessionLog } from './sessions.js';
import { streamSessionTail, isTailable } from './sessions-tail.js';
import { showHostTaskLog } from '../lib/hosts/logs.js';
import { listTasks, type HostTask } from '../lib/hosts/tasks.js';
import { itemPicker } from '../lib/picker.js';

interface LogsOptions {
  host?: string;
  agent?: string;
  version?: string;
  session?: string;
  follow?: boolean;
}

type Candidate =
  | { kind: 'task'; task: HostTask }
  | { kind: 'session'; session: SessionMeta };

/** Compact one-line label used by both the picker and the non-TTY list. */
function candidateLabel(c: Candidate): string {
  if (c.kind === 'task') {
    const t = c.task;
    const status = t.status === 'completed' ? chalk.green(t.status)
      : t.status === 'failed' ? chalk.red(t.status)
      : chalk.yellow(t.status);
    return `${chalk.gray('task')} ${t.id.slice(0, 8).padEnd(9)} ${t.host.padEnd(14)} ${t.agent.padEnd(8)} ${status}  ${t.prompt.slice(0, 40)}`;
  }
  const s = c.session;
  const ver = s.version ? chalk.gray(`@${s.version}`) : '';
  const title = (s as { label?: string }).label || s.topic || '';
  return `${chalk.gray('sess')} ${s.shortId.padEnd(9)} ${(s.agent + ver).padEnd(14)} ${chalk.gray(s.timestamp.slice(0, 16))}  ${title.slice(0, 40)}`;
}

/** Show a resolved session — follow (tail) or render its transcript. */
async function showSession(session: SessionMeta, follow: boolean): Promise<void> {
  if (follow) {
    if (!isTailable(session.agent)) {
      console.error(chalk.red(`Tailing is supported for claude and codex sessions only (got ${session.agent}).`));
      process.exit(2);
    }
    await streamSessionTail(session, {});
    return;
  }
  await renderSessionLog(session);
}

async function showCandidate(c: Candidate, follow: boolean): Promise<void> {
  if (c.kind === 'task') {
    const res = await showHostTaskLog(c.task.id, follow);
    if (res.exitCode !== undefined) process.exitCode = res.exitCode;
    return;
  }
  await showSession(c.session, follow);
}

/** Resolve an explicit id/--session: host task first, then a session. */
async function showById(id: string, follow: boolean): Promise<void> {
  const hostRes = await showHostTaskLog(id, follow);
  if (hostRes.found) {
    if (hostRes.exitCode !== undefined) process.exitCode = hostRes.exitCode;
    return;
  }
  const sessions = await discoverSessions({ all: true, limit: 5000 });
  const matches = resolveSessionById(sessions, id);
  if (matches.length === 0) {
    console.error(chalk.red(`No run or session found matching "${id}".`));
    process.exit(1);
  }
  await showSession(matches[0], follow);
}

async function runLogs(id: string | undefined, opts: LogsOptions): Promise<void> {
  const follow = !!opts.follow;

  const directId = opts.session ?? id;
  if (directId) {
    await showById(directId, follow);
    return;
  }

  const { agent, version } = parseAgentFilter(opts.agent);
  const wantVersion = opts.version ?? version;

  // Host tasks carry no session-index metadata; sessions carry no host tag.
  // So --host scopes to dispatched tasks, and --version to sessions.
  const candidates: Candidate[] = [];

  let tasks = listTasks();
  if (opts.host) tasks = tasks.filter((t) => t.host === opts.host);
  if (agent) tasks = tasks.filter((t) => t.agent === agent);
  for (const t of tasks) candidates.push({ kind: 'task', task: t });

  if (!opts.host) {
    const sessions = await discoverSessions({ agent, version: wantVersion, limit: 50 });
    for (const s of sessions) candidates.push({ kind: 'session', session: s });
  }

  if (candidates.length === 0) {
    console.error(chalk.yellow('No matching runs. Dispatch one: agents run <agent> "<task>" [--host <name>]'));
    process.exit(1);
  }

  if (candidates.length === 1) {
    await showCandidate(candidates[0], follow);
    return;
  }

  // Multiple sessions matched → picker if interactive, else a list to pick from.
  if (!process.stdin.isTTY) {
    console.error(chalk.yellow(`${candidates.length} runs match. Pass an id or --session <id>:`));
    for (const c of candidates.slice(0, 30)) console.error('  ' + candidateLabel(c));
    process.exit(1);
  }

  const picked = await itemPicker<Candidate>({
    message: 'Select a run to view its log:',
    items: candidates,
    filter: (query: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return candidates;
      return candidates.filter((c) => candidateLabel(c).toLowerCase().includes(q));
    },
    labelFor: (c: Candidate) => candidateLabel(c),
    shortIdFor: (c: Candidate) => (c.kind === 'task' ? c.task.id : c.session.shortId),
  });
  if (!picked) return;
  await showCandidate(picked.item, follow);
}

/** Register the top-level `agents logs` command. */
export function registerLogsCommand(program: Command): void {
  program
    .command('logs [id]')
    .description('Show a run’s log — a host-dispatch task or a session. -f to follow a live one.')
    .option('--host <name>', 'Scope to runs dispatched to a host')
    .option('-a, --agent <agent>', 'Filter by agent (e.g. claude, codex@0.116.0)')
    .option('--version <version>', 'Filter by agent version')
    .option('--session <id>', 'Select a session/run by id (same as the positional id)')
    .option('-f, --follow', 'Follow live output')
    .action((id: string | undefined, opts: LogsOptions) => runLogs(id, opts));
}
