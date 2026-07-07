import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

// Written by the SessionStart hook in @agents/session-tracker.
const STATE_DIR = path.join(os.homedir(), '.agents', '.cache', 'terminals', 'sessions');

export interface SessionStateRecord {
  session_id: string;
  cwd?: string;
  pid: number;
  ts: number;
}

// macOS `pgrep -P` silently misses children for some pids; `ps -eo` is reliable.
async function buildChildIndex(): Promise<Map<number, number[]>> {
  const index = new Map<number, number[]>();
  const { stdout } = await execAsync('ps -eo pid,ppid', { timeout: 2000 });
  for (const line of stdout.split('\n').slice(1)) {
    const [pidStr, ppidStr] = line.trim().split(/\s+/);
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const kids = index.get(ppid);
    if (kids) kids.push(pid);
    else index.set(ppid, [pid]);
  }
  return index;
}

async function descendantPids(rootPid: number): Promise<number[]> {
  const index = await buildChildIndex();
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  const result: number[] = [];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const c of index.get(pid) ?? []) {
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

/**
 * Find the live session UUID for a running agent process under the given shell.
 * Reads state files written by the SessionStart hook
 * (~/.agents/.cache/terminals/sessions/<agent-pid>.json), keyed by agent process id.
 *
 * Returns null when no agent process is currently running under the shell — caller
 * decides whether to fall back to a spawn-time env var or report "no session".
 */
export async function liveSessionIdForShell(shellPid: number | undefined): Promise<string | null> {
  if (!shellPid) return null;
  // Check the root pid itself (covers cases where the agent runs directly under
  // the terminal with no wrapping shell), then descendants. When multiple pids
  // in the tree have state files (e.g. a wrapper + the actual agent both fire
  // SessionStart), prefer the most recently-written one — that's the active
  // session the user is interacting with.
  const pids = [shellPid, ...await descendantPids(shellPid)];
  let best: SessionStateRecord | null = null;
  for (const pid of pids) {
    const rec = await readState(pid);
    if (rec && (!best || rec.ts > best.ts)) best = rec;
  }
  return best?.session_id ?? null;
}

/**
 * Delete state files whose PID is no longer alive. Run on extension activation
 * to bound the size of ~/.agents/.cache/terminals/sessions/. Cheap (~50 stat+kill
 * calls per accumulation cycle).
 */
export async function pruneStaleSessionState(): Promise<number> {
  let files: string[];
  try {
    files = await fs.readdir(STATE_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const pid = Number(name.slice(0, -5));
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          await fs.unlink(path.join(STATE_DIR, name));
          removed++;
        } catch {
          // best-effort
        }
      }
    }
  }
  return removed;
}
