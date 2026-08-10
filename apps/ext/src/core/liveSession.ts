import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

// Written by the fleet's ACTUALLY-DEPLOYED SessionStart hook (agents-cli), which
// writes ~/.agents/.cache/state/sessions/<pid>.json ({session_id,cwd,pid,ts}).
// NOT the @agents/session-tracker package's ~/.agents/.cache/terminals/sessions/
// path — that package is not deployed on the fleet and its dir stays empty, so a
// read there always missed and this lookup could never resolve a live id.
const STATE_DIR = path.join(os.homedir(), '.agents', '.cache', 'state', 'sessions');

export interface SessionStateRecord {
  session_id: string;
  cwd?: string;
  pid: number;
  ts: number;
}

/**
 * Parse the `ps` ELAPSED / `etime` field (`[[dd-]hh:]mm:ss`) into seconds.
 * macOS `ps` has no `etimes` (raw seconds) keyword, so this format is the only
 * one both macOS and Linux emit. Returns null for an unparseable value.
 */
export function parseElapsedSeconds(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  const days = Number(dd ?? 0);
  const hours = Number(hh ?? 0);
  const mins = Number(mm);
  const secs = Number(ss);
  return ((days * 24 + hours) * 60 + mins) * 60 + secs;
}

interface ProcessTables {
  /** ppid -> child pids. */
  children: Map<number, number[]>;
  /** pid -> approximate process start time (ms since epoch), from ELAPSED. */
  startMs: Map<number, number>;
}

// macOS `pgrep -P` silently misses children for some pids; `ps -eo` is reliable.
// One `ps` call yields both the child index (for the pid tree) and each pid's
// start time (for the recycled-pid guard) — the two things the lookup needs.
async function buildProcessTables(nowMs: number): Promise<ProcessTables> {
  const children = new Map<number, number[]>();
  const startMs = new Map<number, number>();
  const { stdout } = await execAsync('ps -eo pid,ppid,etime', { timeout: 2000 });
  for (const line of stdout.split('\n').slice(1)) {
    // ELAPSED is a single space-free token (`[[dd-]hh:]mm:ss`), so a plain
    // whitespace split yields exactly [pid, ppid, etime].
    const [pidStr, ppidStr, etime] = line.trim().split(/\s+/);
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const kids = children.get(ppid);
    if (kids) kids.push(pid);
    else children.set(ppid, [pid]);
    const elapsed = etime ? parseElapsedSeconds(etime) : null;
    if (elapsed !== null) startMs.set(pid, nowMs - elapsed * 1000);
  }
  return { children, startMs };
}

function descendantPids(rootPid: number, children: Map<number, number[]>): number[] {
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  const result: number[] = [];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const c of children.get(pid) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      result.push(c);
      queue.push(c);
    }
  }
  return result;
}

async function readState(pid: number): Promise<SessionStateRecord | null> {
  try {
    const raw = await fs.readFile(path.join(STATE_DIR, `${pid}.json`), 'utf8');
    const parsed = JSON.parse(raw) as SessionStateRecord;
    return parsed?.session_id ? parsed : null;
  } catch {
    return null;
  }
}

// The hook keys its state files by pid and nothing deletes them when the agent
// dies, so a file outlives its process and the OS eventually hands that pid to
// something else. Reading it back then attributes a stranger's session to this
// terminal. The record's SessionStart timestamp settles it: an agent under this
// tab cannot have started before the tab existed, so a record older than the
// terminal belongs to the pid's previous owner. Seconds-granularity `ts` gets a
// small slack so a session started in the same second as the tab still counts.
const RECYCLED_PID_SLACK_MS = 5_000;

export function recordPredatesTerminal(rec: SessionStateRecord, terminalCreatedAtMs: number): boolean {
  if (!Number.isFinite(rec.ts) || rec.ts <= 0) return false;
  return rec.ts * 1000 < terminalCreatedAtMs - RECYCLED_PID_SLACK_MS;
}

// The terminal-age guard above can't separate two agents started close together
// (the Kimi "wrong session id + version" case: a ~30h-old dead session's file
// bound to a same-age long-running tab in the same repo — their timestamps were
// too close for recordPredatesTerminal to reject). The precise discriminator is
// the START of the process that CURRENTLY holds the pid: the hook wrote `ts` when
// its agent started, so if the process now at that pid started meaningfully after
// `ts`, the OS recycled the pid and the file belongs to the previous owner.
export function recordPredatesProcess(rec: SessionStateRecord, processStartMs: number): boolean {
  if (!Number.isFinite(rec.ts) || rec.ts <= 0) return false;
  return rec.ts * 1000 < processStartMs - RECYCLED_PID_SLACK_MS;
}

/**
 * Find the live session UUID for a running agent process under the given shell.
 * Reads state files written by the SessionStart hook
 * (~/.agents/.cache/state/sessions/<agent-pid>.json), keyed by agent process id.
 *
 * Returns null when no agent process is currently running under the shell — caller
 * decides whether to fall back to a spawn-time env var or report "no session".
 *
 * `terminalCreatedAtMs` rejects a state file left behind by a dead agent whose pid
 * the OS has since recycled (see {@link recordPredatesTerminal}). Independently,
 * each pid's own process start time rejects a recycled pid even when the terminal
 * is as old as the stale file ({@link recordPredatesProcess}). Callers that
 * genuinely have no terminal to date the lookup against may omit it.
 */
export async function liveSessionIdForShell(
  shellPid: number | undefined,
  terminalCreatedAtMs?: number,
): Promise<string | null> {
  if (!shellPid) return null;
  const tables = await buildProcessTables(Date.now());
  // Check the root pid itself (covers cases where the agent runs directly under
  // the terminal with no wrapping shell), then descendants. When multiple pids
  // in the tree have state files (e.g. a wrapper + the actual agent both fire
  // SessionStart), prefer the most recently-written one — that's the active
  // session the user is interacting with.
  const pids = [shellPid, ...descendantPids(shellPid, tables.children)];
  let best: SessionStateRecord | null = null;
  for (const pid of pids) {
    const rec = await readState(pid);
    if (!rec) continue;
    if (terminalCreatedAtMs !== undefined && recordPredatesTerminal(rec, terminalCreatedAtMs)) continue;
    const processStartMs = tables.startMs.get(pid);
    if (processStartMs !== undefined && recordPredatesProcess(rec, processStartMs)) continue;
    if (!best || rec.ts > best.ts) best = rec;
  }
  return best?.session_id ?? null;
}
