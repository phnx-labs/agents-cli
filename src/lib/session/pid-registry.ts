/**
 * Per-PID session registry — the headless equivalent of the swarmify VS Code
 * extension's `live-terminals.json`.
 *
 * On a machine with no terminal extension (a bare SSH/tmux host), the only way
 * `ag sessions --active` can attribute a `ps`-discovered agent process to a
 * session is to guess "newest .jsonl in the cwd" — which collapses N agents
 * sharing one repo onto a single session (all rows show the same topic/id).
 *
 * `ag run` closes that gap by recording, at spawn time, one file per launched
 * agent process keyed by its OS pid: the exact session id it was launched with
 * (Claude is started with `--session-id <uuid>`, so the launcher knows it),
 * plus agent/cwd/tmux pane. The active-sessions headless path reads it back for
 * an exact pid -> session match instead of a heuristic.
 *
 * Best-effort throughout: a failed write or a corrupt file degrades to the old
 * heuristic, never throws into the launch or the listing path.
 */
import fs from 'fs';
import path from 'path';
import { getTerminalsDir } from '../state.js';

export interface PidSessionEntry {
  pid: number;
  agent: string;
  /** The launch session id. Present for agents launched with a known id (Claude). */
  sessionId?: string;
  cwd?: string;
  /**
   * `$TMUX_PANE` at launch — stored for diagnostics and possible future
   * disambiguation. NOT currently consulted on read: the listing path keys
   * purely on pid (stale entries are pruned when the pid dies), so this is
   * metadata, not an anti-collision key.
   */
  tmuxPane?: string;
  startedAtMs: number;
}

/**
 * Pull an explicit `--session-id <uuid>` (or `--session-id=<uuid>`) out of a
 * raw agent arg vector. The transparent shim forwards args untouched, but when
 * a launcher (Claude Code background jobs, IDE harnesses) already names the
 * session, recording it gives the same exact pid -> session mapping `ag run`
 * gets from generating the id itself.
 */
const SESSION_ID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function extractSessionIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session-id') {
      const v = args[i + 1];
      if (v && SESSION_ID_VALUE_RE.test(v)) return v;
    } else if (a.startsWith('--session-id=')) {
      const v = a.slice('--session-id='.length);
      if (SESSION_ID_VALUE_RE.test(v)) return v;
    }
  }
  return undefined;
}

function pidRegistryDir(): string {
  return path.join(getTerminalsDir(), 'by-pid');
}

function entryPath(pid: number): string {
  return path.join(pidRegistryDir(), `${pid}.json`);
}

/** Record a launched agent process. Never throws — the registry is an optimization. */
export function writePidSessionEntry(entry: PidSessionEntry): void {
  if (!entry.pid || entry.pid < 1) return;
  try {
    fs.mkdirSync(pidRegistryDir(), { recursive: true });
    fs.writeFileSync(entryPath(entry.pid), JSON.stringify(entry), 'utf8');
  } catch {
    /* degrade to the newest-jsonl heuristic */
  }
}

/** Look up a live pid's recorded session. Returns undefined if absent/corrupt. */
export function readPidSessionEntry(pid: number): PidSessionEntry | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(entryPath(pid), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.pid === 'number') {
      return parsed as PidSessionEntry;
    }
  } catch {
    /* unparseable */
  }
  return undefined;
}

/** Remove entries whose pid is no longer alive. Best-effort housekeeping. */
export function prunePidSessionRegistry(isAlive: (pid: number) => boolean): void {
  let files: string[];
  try {
    files = fs.readdirSync(pidRegistryDir()).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of files) {
    const pid = Number(f.slice(0, -'.json'.length));
    if (!Number.isInteger(pid) || isAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(pidRegistryDir(), f));
    } catch {
      /* raced with another writer/pruner */
    }
  }
}
