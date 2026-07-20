/**
 * `agents logs` — unified, discoverable run-log viewer + audit trail.
 *
 * Resolves a run across two substrates and shows (or `-f` follows) its log:
 *  - host-dispatch tasks (`agents run --host`) → combined-stdout log, offset-tailed
 *  - sessions (the local index) → transcript, tailed via the sessions tailer
 *
 * Subcommands:
 *  - `agents logs audit` — read the structured audit/event log
 *  - `agents logs stats` — show aggregate audit statistics
 *
 * Concise by default: a bare `agents logs <id>` prints the same summary digest as
 * `agents sessions <id>` — cheap for an agent to glance at. The token-heavy full
 * transcript / raw stdout is opt-in behind `--full` (alias `-m/--markdown`).
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
import * as fs from 'fs';
import type { SessionMeta } from '../lib/session/types.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { parseAgentFilter, renderSessionLog, renderSessionLogJson } from './sessions.js';
import { streamSessionTail, isTailable } from './sessions-tail.js';
import { showHostTaskLog, hostTaskLogJson } from '../lib/hosts/logs.js';
import { listTasks, type HostTask } from '../lib/hosts/tasks.js';
import { itemPicker } from '../lib/picker.js';
import {
  query, stats, getLogsPath, rotate, levelFor,
  type EventRecord, type EventType, type EventLevel,
} from '../lib/events.js';

interface LogsOptions {
  host?: string;
  agent?: string;
  version?: string;
  session?: string;
  follow?: boolean;
  full?: boolean;
  json?: boolean;
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

/** Emit a host-dispatch task's log as JSON: `{ kind, task, log }`. */
function emitHostTaskJson(id: string): boolean {
  const hj = hostTaskLogJson(id);
  if (!hj.found) return false;
  process.stdout.write(JSON.stringify({ kind: 'task', task: hj.task, log: hj.log ?? null }, null, 2) + '\n');
  return true;
}

/** Show a resolved session — follow (tail), concise summary, or (`full`) transcript. */
async function showSession(session: SessionMeta, follow: boolean, full: boolean, json = false): Promise<void> {
  if (json) {
    await renderSessionLogJson(session);
    return;
  }
  if (follow) {
    if (!isTailable(session.agent)) {
      console.error(chalk.red(`Tailing is supported for claude and codex sessions only (got ${session.agent}).`));
      process.exit(2);
    }
    await streamSessionTail(session, {});
    return;
  }
  await renderSessionLog(session, full ? 'markdown' : 'summary');
}

async function showCandidate(c: Candidate, follow: boolean, full: boolean, json = false): Promise<void> {
  if (c.kind === 'task') {
    if (json) {
      emitHostTaskJson(c.task.id);
      return;
    }
    const res = await showHostTaskLog(c.task.id, follow, full);
    if (res.exitCode !== undefined) process.exitCode = res.exitCode;
    return;
  }
  await showSession(c.session, follow, full, json);
}

/** Resolve an explicit id/--session: host task first, then a session. */
async function showById(id: string, follow: boolean, full: boolean, json = false): Promise<void> {
  if (json) {
    if (emitHostTaskJson(id)) return;
    const sessions = await discoverSessions({ all: true, limit: 5000 });
    const matches = resolveSessionById(sessions, id);
    if (matches.length === 0) {
      console.error(chalk.red(`No run or session found matching "${id}".`));
      process.exit(1);
    }
    await renderSessionLogJson(matches[0]);
    return;
  }
  const hostRes = await showHostTaskLog(id, follow, full);
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
  await showSession(matches[0], follow, full);
}

async function runLogs(id: string | undefined, opts: LogsOptions): Promise<void> {
  const follow = !!opts.follow;
  const full = !!opts.full;

  const directId = opts.session ?? id;
  if (directId) {
    await showById(directId, follow, full, !!opts.json);
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
    await showCandidate(candidates[0], follow, full, !!opts.json);
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
  await showCandidate(picked.item, follow, full, !!opts.json);
}

// ─── Audit subcommand ────────────────────────────────────────────────────────

interface AuditOptions {
  module?: string;
  command?: string;
  event?: string[];
  agent?: string;
  caller?: string;
  level?: string;
  since?: string;
  limit?: string;
  json?: boolean;
  follow?: boolean;
}

function parseSince(s: string): Date {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs: Record<string, number> = {
      s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
    };
    return new Date(Date.now() - n * unitMs[m[2]]);
  }
  const ms = Date.parse(s);
  if (isNaN(ms)) throw new Error(`Invalid --since value: ${s} (use e.g. 2h, 7d, or an ISO date)`);
  return new Date(ms);
}

function originLabel(r: EventRecord): string {
  if (r.transport === 'ssh') {
    return chalk.yellow(`ssh${r.sshClientIp ? ' ' + r.sshClientIp : ''}`);
  }
  return chalk.gray('local');
}

function auditDetailFor(r: EventRecord): string {
  if (r.command) return r.command;
  const bits: string[] = [];
  if (typeof r.team === 'string') bits.push(`team=${r.team}`);
  if (typeof r.bundle === 'string') bits.push(`bundle=${r.bundle}`);
  if (typeof r.skill === 'string') bits.push(`skill=${r.skill}`);
  if (typeof r.version === 'string') bits.push(`v=${r.version}`);
  if (typeof r.profile === 'string') bits.push(`profile=${r.profile}`);
  if (typeof r.server === 'string') bits.push(`server=${r.server}`);
  if (typeof r.error === 'string') bits.push(chalk.red(r.error));
  return bits.join(' ');
}

function levelColor(level: string): string {
  if (level === 'audit') return chalk.magenta(level);
  if (level === 'warn') return chalk.yellow(level);
  if (level === 'debug') return chalk.gray(level);
  return chalk.blue(level);
}

function renderAuditRow(r: EventRecord): string {
  const time = chalk.gray(r.ts.slice(0, 19).replace('T', ' '));
  const user = `${r.osUser ?? '?'}@${r.hostname}`;
  const ev = r.event.startsWith('error') ? chalk.red(r.event) : chalk.cyan(r.event);
  const lvl = levelColor(r.level ?? levelFor(r.event as EventType));
  const agent = r.agent ? chalk.gray(` ${r.agent}`) : '';
  const caller = chalk.gray(`via ${r.caller ?? 'unknown'}${r.session ? ` ${r.session}` : ''}`);
  return `${time}  ${lvl.padEnd(14)} ${originLabel(r).padEnd(24)} ${user.padEnd(22)} ${caller.padEnd(28)} ${ev.padEnd(26)}${agent}  ${auditDetailFor(r)}`;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

async function runAudit(opts: AuditOptions): Promise<void> {
  if (opts.follow) {
    await followAuditLog();
    return;
  }

  const limit = Math.max(1, parseInt(opts.limit ?? '50', 10) || 50);
  let startDate: Date | undefined;
  try {
    startDate = opts.since ? parseSince(opts.since) : undefined;
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(2);
  }

  const records = query({
    startDate,
    eventTypes: opts.event?.length ? (opts.event as EventType[]) : undefined,
    level: opts.level as EventLevel | undefined,
    agent: opts.agent,
    caller: opts.caller,
    command: opts.command,
    module: opts.module,
    limit,
  });

  if (opts.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log(chalk.gray('No matching events.'));
    return;
  }

  for (const r of records.slice().reverse()) console.log(renderAuditRow(r));
  console.log(chalk.gray(`\n${records.length} event(s). Log: ${getLogsPath()}`));
}

async function followAuditLog(): Promise<void> {
  const file = getLogsPath();
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    // File may not exist yet — start at 0.
  }
  console.log(chalk.gray(`Tailing ${file} — Ctrl-C to stop`));
  const drain = () => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) {
      if (size < offset) offset = 0;
      return;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      for (const line of buf.toString('utf-8').split('\n').filter(Boolean)) {
        try {
          console.log(renderAuditRow(JSON.parse(line) as EventRecord));
        } catch {
          // Skip malformed lines.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  await new Promise<void>(() => {
    setInterval(drain, 500);
  });
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function runStats(opts: { since?: string; json?: boolean }): Promise<void> {
  let days = 7;
  if (opts.since) {
    try {
      const d = parseSince(opts.since);
      days = Math.max(1, Math.ceil((Date.now() - d.getTime()) / 86_400_000));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(2);
    }
  }

  const s = stats({ days });

  if (opts.json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  console.log(chalk.bold(`Audit statistics (last ${days} day${days === 1 ? '' : 's'})\n`));
  console.log(`  Total events:  ${s.totalEvents}`);
  console.log(`  Log files:     ${s.fileCount} (${humanBytes(s.totalBytes)})`);
  console.log(`  Log path:      ${chalk.gray(getLogsPath())}`);

  if (Object.keys(s.byLevel).length) {
    console.log(chalk.bold('\n  By level:'));
    for (const [k, v] of Object.entries(s.byLevel).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${levelColor(k).padEnd(20)} ${v}`);
    }
  }

  if (Object.keys(s.byEvent).length) {
    console.log(chalk.bold('\n  By event (top 15):'));
    for (const [k, v] of Object.entries(s.byEvent).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${chalk.cyan(k).padEnd(30)} ${v}`);
    }
  }

  if (Object.keys(s.byModule).length) {
    console.log(chalk.bold('\n  By module:'));
    for (const [k, v] of Object.entries(s.byModule).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(20)} ${v}`);
    }
  }

  if (Object.keys(s.byUser).length) {
    console.log(chalk.bold('\n  By user:'));
    for (const [k, v] of Object.entries(s.byUser).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(30)} ${v}`);
    }
  }

  console.log();
}

/** Register the top-level `agents logs` command. */
export function registerLogsCommand(program: Command): void {
  const logsCmd = program
    .command('logs [id]')
    .description('Show a run log, audit trail, or stats. Subcommands: audit, stats, rotate.')
    .option('--host <name>', 'Scope to runs dispatched to a host')
    .option('-a, --agent <agent>', 'Filter by agent (e.g. claude, codex@0.116.0)')
    .option('--version <version>', 'Filter by agent version')
    .option('--session <id>', 'Select a session/run by id (same as the positional id)')
    .option('-f, --follow', 'Follow live output')
    .option('-m, --full', 'Show the full raw transcript / stdout instead of the concise summary')
    .option('--json', 'Machine-readable JSON: a host task as { kind, task, log }, a session as the redacted { session, events } (same shape as `sessions <id> --json`)')
    .action((id: string | undefined, opts: LogsOptions) => runLogs(id, opts));

  logsCmd
    .command('audit')
    .description('Read the structured audit/event log (who ran what, from where)')
    .option('--module <name>', 'Only events from this command group (e.g. teams, secrets)')
    .option('--command <path>', 'Only this command path — prefix match (e.g. "teams create")')
    .option('--event <type>', 'Only this typed event (repeatable)', collect, [])
    .option('--agent <name>', 'Only events tagged with this agent')
    .option('--caller <kind>', 'Only this caller kind (claude-code, codex, gemini, cursor, terminal, script)')
    .option('--level <level>', 'Only this level: audit, warn, info, debug')
    .option('--since <time>', 'Only events newer than this (e.g. 2h, 7d, or ISO date)')
    .option('--limit <n>', 'Max records to show (default 50)', '50')
    .option('--json', 'Output raw records as JSON')
    .option('-f, --follow', "Tail today's log live")
    .addHelpText('after', `
Examples:
  agents logs audit                          Recent activity across everything
  agents logs audit --module teams           Team lifecycle (create / add / disband)
  agents logs audit --module secrets         Every secret accessed or revealed
  agents logs audit --level audit            Only audit-level events
  agents logs audit --command "teams create" Just team creations
  agents logs audit --event secrets.get --since 7d --json
  agents logs audit -f                       Live tail`)
    .action(async (options: AuditOptions) => runAudit(options));

  logsCmd
    .command('stats')
    .description('Show aggregate audit statistics')
    .option('--since <time>', 'Window size (e.g. 7d, 30d; default 7d)')
    .option('--json', 'Output stats as JSON')
    .action(async (opts: { since?: string; json?: boolean }) => runStats(opts));

  logsCmd
    .command('rotate')
    .description('Force log rotation — remove files older than the retention period')
    .option('--days <n>', 'Retention period in days (default 7)', '7')
    .action((opts: { days?: string }) => {
      const days = Math.max(1, parseInt(opts.days ?? '7', 10) || 7);
      const removed = rotate(days);
      if (removed > 0) {
        console.log(`Removed ${removed} log file${removed === 1 ? '' : 's'} older than ${days} day${days === 1 ? '' : 's'}.`);
      } else {
        console.log(chalk.gray('No log files to remove.'));
      }
    });
}
