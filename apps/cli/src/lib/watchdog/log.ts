/**
 * Canonical watchdog event log (watchdog-brain-v2).
 *
 * The Factory Floor renders a read-only "Watchdog activity" card from the JSONL
 * feed at ~/.agents/.cache/logs/watchdog.log. That feed was historically written
 * by the retired extension-side watchdog; now the always-on CLI watchdog owns it.
 *
 * The event SHAPE here is a deliberate, verbatim replica of the reader in
 * apps/factory/src/core/watchdogLog.ts (WatchdogEvent / WatchdogEventKind /
 * WATCHDOG_LOG_PATH / the trim cap). The repo forbids cross-app imports
 * (CLAUDE.md repo map), so the two files are kept in sync by hand — a change to
 * the Factory reader's shape must be mirrored here. There is no import between
 * them.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withFileLock, atomicWriteFileSync, ensureLockTarget } from '../fs-atomic.js';

/** Same path the Factory reader pulls (apps/factory/src/core/watchdogLog.ts). */
export const WATCHDOG_LOG_PATH = path.join(os.homedir(), '.agents', '.cache', 'logs', 'watchdog.log');

/** Kinds the Factory reader accepts. Keep in lockstep with watchdogLog.ts. */
export type WatchdogEventKind = 'tick' | 'decision' | 'nudge' | 'rotate' | 'error';

/** JSONL row shape — a verbatim replica of the Factory reader's WatchdogEvent. */
export interface WatchdogEvent {
  ts: number;
  kind: WatchdogEventKind;
  terminalId?: string;
  agentType?: string;
  message: string;
  reason?: string;
  /** For 'tick' events: the session lines the watchdog actually read. */
  tailLines?: string[];
  /** For 'tick' / 'decision' events: how long the terminal had been stalled. */
  stalledForMs?: number;
  /** Carried so the UI can show what the agent was stuck on. */
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  /** For a 'decision'/'nudge' that injects: the exact text delivered. */
  nudgeText?: string;
}

/** Serialize one event to a JSONL line (no trailing newline). */
export function formatEvent(ev: WatchdogEvent): string {
  return JSON.stringify(ev);
}

/**
 * Cap on retained log lines. Mirrors the Factory reader's expectation that the
 * writer trims (watchdogLog.ts trimToLast). Large enough to keep a useful
 * history, small enough to bound the file the UI polls.
 */
export const WATCHDOG_LOG_MAX_LINES = 2000;

/** Trim a JSONL body to the last `maxLines` events (same logic as the reader). */
export function trimToLast(text: string, maxLines: number): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length <= maxLines) return lines.join('\n') + (lines.length ? '\n' : '');
  return lines.slice(lines.length - maxLines).join('\n') + '\n';
}

/**
 * Append events to the log under a file lock, trimming to WATCHDOG_LOG_MAX_LINES
 * so the file never grows unbounded. Concurrent watchdog ticks share the lock so
 * their appends never interleave into a corrupt line. Best-effort: a filesystem
 * error is swallowed (the Factory card tolerates a stale/missing log), never
 * throwing into the tick.
 */
export function appendWatchdogEvents(
  events: WatchdogEvent[],
  opts: { logPath?: string; maxLines?: number } = {},
): void {
  if (events.length === 0) return;
  const logPath = opts.logPath ?? WATCHDOG_LOG_PATH;
  const maxLines = opts.maxLines ?? WATCHDOG_LOG_MAX_LINES;
  const lockPath = path.join(path.dirname(logPath), '.watchdog.log.lock');
  try {
    ensureLockTarget(lockPath);
    withFileLock(lockPath, () => {
      let existing = '';
      try {
        existing = fs.readFileSync(logPath, 'utf8');
      } catch {
        /* first write — no file yet */
      }
      const appended = events.map(formatEvent).join('\n') + '\n';
      const body = trimToLast(existing + appended, maxLines);
      atomicWriteFileSync(logPath, body);
    });
  } catch {
    /* best-effort: never let logging break a tick */
  }
}
