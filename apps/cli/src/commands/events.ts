/**
 * `agents events` — read the unified event stream.
 *
 * One stream over BOTH operational events (`~/.agents/events.jsonl`: every
 * `agents <module> <cmd>` invocation plus typed events like secrets access,
 * version installs) AND agent-semantic events (the per-session activity logs:
 * plans, PRs, worktrees, sub-agents, artifacts). Each is stamped with who ran
 * it and from where. This is the audit trail for "who accessed a secret /
 * created a team" AND the activity trail for "what did the agents just do".
 *
 * Filter by `--module` (top-level group, e.g. teams; `activity` for agent
 * events), `--command` (path prefix), `--event` (typed event), `--agent`, and
 * `--since`. `--audit` restricts to operational events only. `--follow` tails
 * today's operational log live.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { getLogsPath, type EventRecord, type EventType } from '../lib/events.js';
import { readUnifiedEvents } from '../lib/event-stream.js';

interface EventsOptions {
  module?: string;
  command?: string;
  event?: string[];
  agent?: string;
  since?: string;
  limit?: string;
  json?: boolean;
  follow?: boolean;
  audit?: boolean;
}

/** Parse `--since`: relative offsets (30s/5m/2h/7d/4w) or an ISO/absolute date. */
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

/** How the run reached this host — 'local' or 'ssh 203.0.113.7'. */
function originLabel(r: EventRecord): string {
  if (r.transport === 'ssh') {
    return chalk.yellow(`ssh${r.sshClientIp ? ' ' + r.sshClientIp : ''}`);
  }
  return chalk.gray('local');
}

/** The most useful one-line detail for a record, by event family. */
function detailFor(r: EventRecord): string {
  if (r.command) return r.command;
  const bits: string[] = [];
  // Agent-semantic (activity) events carry detail/url instead of a command.
  if (typeof r.detail === 'string') bits.push(r.detail);
  if (typeof r.url === 'string') bits.push(chalk.gray(r.url));
  if (typeof r.team === 'string') bits.push(`team=${r.team}`);
  if (typeof r.bundle === 'string') bits.push(`bundle=${r.bundle}`);
  if (typeof r.skill === 'string') bits.push(`skill=${r.skill}`);
  if (typeof r.version === 'string') bits.push(`v=${r.version}`);
  if (typeof r.profile === 'string') bits.push(`profile=${r.profile}`);
  if (typeof r.error === 'string') bits.push(chalk.red(r.error));
  return bits.join(' ');
}

function renderRow(r: EventRecord): string {
  const time = chalk.gray(r.ts.slice(0, 19).replace('T', ' '));
  const user = `${r.osUser ?? '?'}@${r.hostname}`;
  const ev = r.event.startsWith('error') ? chalk.red(r.event) : chalk.cyan(r.event);
  const agent = r.agent ? chalk.gray(` ${r.agent}`) : '';
  return `${time}  ${originLabel(r).padEnd(24)} ${user.padEnd(22)} ${ev.padEnd(26)}${agent}  ${detailFor(r)}`;
}

export function registerEventsCommand(program: Command): void {
  program
    .command('events')
    .description('Read the unified event stream (operational + agent activity)')
    .option('--module <name>', 'Only events from this group (e.g. teams, secrets, activity)')
    .option('--command <path>', 'Only this command path — prefix match (e.g. "teams create")')
    .option('--event <type>', 'Only this typed event (repeatable, e.g. secrets.get, secrets.unlocked, pr.opened)', collect, [])
    .option('--agent <name>', 'Only events tagged with this agent')
    .option('--since <time>', 'Only events newer than this (e.g. 2h, 7d, or ISO date)')
    .option('--audit', 'Operational events only (skip agent activity)')
    .option('--limit <n>', 'Max records to show (default 50)', '50')
    .option('--json', 'Output raw records as JSON')
    .option('-f, --follow', "Tail today's operational log live")
    .addHelpText('after', `
Examples:
  agents events                          Everything — ops + agent activity
  agents events --module activity        Agent activity only (plans / PRs / worktrees)
  agents events --audit                  Operational events only (secrets / teams / ...)
  agents events --event pr.opened --since 7d
  agents events --module secrets         Every secret accessed or revealed
  agents events -f                       Live tail (operational)`)
    .action(async (options: EventsOptions) => {
      if (options.follow) {
        await followLog();
        return;
      }

      const limit = Math.max(1, parseInt(options.limit ?? '50', 10) || 50);
      let startDate: Date | undefined;
      try {
        startDate = options.since ? parseSince(options.since) : undefined;
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(2);
      }

      const records = readUnifiedEvents({
        startDate,
        eventTypes: options.event && options.event.length ? (options.event as EventType[]) : undefined,
        agent: options.agent,
        command: options.command,
        module: options.module,
        limit,
        includeActivity: !options.audit,
      });

      if (options.json) {
        console.log(JSON.stringify(records, null, 2));
        return;
      }

      if (records.length === 0) {
        console.log(chalk.gray('No matching events.'));
        return;
      }

      // query() returns newest-first; print oldest-first so a tail reads naturally.
      for (const r of records.slice().reverse()) console.log(renderRow(r));
      console.log(chalk.gray(`\n${records.length} event(s). Log: ${getLogsPath()}`));
    });
}

/** commander repeatable-option collector. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Tail today's event file, printing new lines as they land. */
async function followLog(): Promise<void> {
  const file = getLogsPath();
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    // File may not exist yet — start at 0 and pick it up on first write.
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
      if (size < offset) offset = 0; // rotated/truncated
      return;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      for (const line of buf.toString('utf-8').split('\n').filter(Boolean)) {
        try {
          console.log(renderRow(JSON.parse(line) as EventRecord));
        } catch {
          // Skip malformed lines.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  // Poll — simpler and more portable than fs.watch across platforms/editors.
  await new Promise<void>(() => {
    setInterval(drain, 500);
  });
}
