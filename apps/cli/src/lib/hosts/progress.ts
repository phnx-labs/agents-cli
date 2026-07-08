/**
 * Follow a dispatched host run by offset-tailing its remote log.
 *
 * The run writes combined output to a log file on the host and its exit code to
 * a sibling `.exit` file. We poll `tail -c +<offset>` (durable, offset-tracked —
 * a dropped connection resumes from the saved offset) and finish when `.exit`
 * appears. Rich transcript-parser rendering is a fast-follow.
 *
 * Efficiency: each cycle is a SINGLE ssh round-trip that returns the new log
 * bytes, a per-task sentinel, then the exit-file contents — half the process +
 * handshake cost of the old tail-then-cat pair. It rides the default control
 * socket (multiplex on) that the launch opened, and eases the poll interval off
 * toward `maxPollMs` while the job is idle, so a quiet long-running follow no
 * longer spawns thousands of ssh processes per hour on the laptop.
 */

import * as fs from 'fs';
import { sshExec, sshExecRaw, shellQuote } from '../ssh-exec.js';
import { localLogPath } from './tasks.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap for the LOCAL mirror of a distributed teammate's remote log. `followHostTask`
 * appends remote bytes into the local mirror forever; a team can spin 10+ chatty
 * remote teammates, so the orchestrator must keep a bounded window (the full log
 * always lives on the host). The teams remote path (agents.ts readNewEvents) writes
 * its own append into each teammate's `stdout.log`, then truncates that file to its
 * trailing `REMOTE_MIRROR_MAX_BYTES` — the parser has already consumed the bytes
 * (status/digest updated via lastReadPos), so trailing-tail history is dead weight.
 */
export const REMOTE_MIRROR_MAX_BYTES = 512 * 1024;

/**
 * Pull the new bytes of a remote log since `offset` in ONE ssh round-trip.
 *
 * The teams remote-teammate monitor calls this each poll to advance its offset-tail
 * cursor into the host's log, mirroring only the delta into the local `stdout.log`
 * the stream-json parser consumes. Byte-exact (raw Buffer, no UTF-8 decode) so a
 * multibyte character split at the `tail -c` boundary neither drifts the offset nor
 * renders as U+FFFD — the same discipline `fetchProgress` uses. `bytes.length` is
 * the exact wire count; `newOffset` is `offset + bytes.length`.
 *
 * Returns null on a transient ssh failure (the caller retries next poll without
 * advancing). `remoteLog` is a $HOME-prefixed path with a safe basename; it's
 * shell-quoted defensively even so.
 */
export function pullRemoteLogDelta(
  target: string,
  opts: { remoteLog: string; offset: number },
): { bytes: Buffer; newOffset: number } | null {
  // remoteLog is a dispatch-generated `$HOME/.agents/.cache/hosts/<hex>.log` path —
  // interpolate UNQUOTED so the remote shell expands `$HOME` (shellQuote would
  // single-quote it into a literal `$HOME`, and the tail would find nothing). The
  // hex basename is injection-safe, matching fetchProgress below.
  const remote = `tail -c +${opts.offset + 1} ${opts.remoteLog} 2>/dev/null`;
  const res = sshExecRaw(target, remote, { timeoutMs: 20000, multiplex: true });
  if (res.code === null) return null; // ssh itself failed / timed out
  return { bytes: res.stdout, newOffset: opts.offset + res.stdout.length };
}

export interface FollowOptions {
  remoteLog: string;
  remoteExit: string;
  /** Mirror remote output into this task's local log too. */
  taskId: string;
  /** Print streamed output to stdout. */
  echo?: boolean;
  /** Overall wall-clock cap; returns -1 on timeout. */
  timeoutMs?: number;
  /** Fast poll interval while output is flowing (default 1500ms). */
  pollMs?: number;
  /** Idle-backoff ceiling (default 4× the fast interval, min 4000ms). */
  maxPollMs?: number;
}

/**
 * Build the per-task sentinel that separates the log tail from the exit-file
 * contents in one combined fetch. The task id (8 hex chars) makes collision with
 * the agent's own output effectively impossible; callers still split on the LAST
 * occurrence so a token echoed into the log can never be mistaken for the real
 * trailing marker.
 */
export function exitMarker(taskId: string): string {
  return `\n@@AGENTS_HOST_EXIT_${taskId}@@\n`;
}

/**
 * Split a combined fetch (`<log bytes><marker><exit>`) back into its parts at the
 * BYTE level. Splits on the LAST marker occurrence, so even if the agent's own
 * output happened to echo the token, the real trailing sentinel still wins.
 * Returns null when the marker is absent (a transient fetch miss — the remote
 * shell never ran our printf), telling the caller to retry without advancing.
 *
 * Byte-level (not string) is load-bearing: `logChunk.length` is the EXACT number
 * of log bytes consumed on the wire, which the follow loop adds to its offset. A
 * string split would first UTF-8-decode, turning any multibyte char split at the
 * `tail -c` boundary into a U+FFFD whose re-encoded length ≠ the wire bytes,
 * drifting the offset (see followHostTask). `consumed` is returned explicitly for
 * clarity; it always equals `logChunk.length`.
 */
export function splitProgressBytes(
  buf: Buffer,
  taskId: string,
): { logChunk: Buffer; exit: Buffer; consumed: number } | null {
  const marker = Buffer.from(exitMarker(taskId), 'utf8'); // ASCII-only, unambiguous
  const idx = buf.lastIndexOf(marker);
  if (idx === -1) return null;
  return {
    logChunk: buf.subarray(0, idx),
    exit: buf.subarray(idx + marker.length),
    consumed: idx,
  };
}

/**
 * One round-trip: new log bytes since `offset`, the sentinel, then the exit
 * file. Returns null on a transient fetch miss (ssh error / marker absent) so
 * the caller simply retries next cycle without advancing the offset.
 *
 * `remoteLog`/`remoteExit` are $HOME-prefixed paths with safe (hex) basenames —
 * intentionally unquoted so the remote shell expands $HOME.
 */
export function fetchProgress(
  target: string,
  opts: { remoteLog: string; remoteExit: string; taskId: string; offset: number },
): { logChunk: Buffer; exit: string } | null {
  // Derive the printf format from the SAME exitMarker the parser splits on, so
  // the emitted sentinel and the one we look for can never desync. The marker's
  // only escape-sensitive bytes are its newlines (→ `\n`); it carries no `%`,
  // single-quote, or other printf/shell-special chars (task id is hex).
  const printfArg = exitMarker(opts.taskId).replace(/\n/g, '\\n');
  const remote =
    `tail -c +${opts.offset + 1} ${opts.remoteLog} 2>/dev/null; ` +
    `printf '${printfArg}'; ` +
    `cat ${opts.remoteExit} 2>/dev/null`;
  // Raw bytes (no UTF-8 decode): the log tail must be counted and re-emitted
  // byte-for-byte so a multibyte char split at the `tail -c` boundary neither
  // drifts the offset nor renders as U+FFFD. The exit code is pure ASCII → safe
  // to decode to a string for the caller's `.trim()`.
  const res = sshExecRaw(target, remote, { timeoutMs: 20000 });
  const parts = splitProgressBytes(res.stdout, opts.taskId);
  if (!parts) return null;
  return { logChunk: parts.logChunk, exit: parts.exit.toString('utf8') };
}

/**
 * File identity (`dev:ino`) of a path on the remote host, or null if it can't be
 * stat'd. GNU (`-c`) then BSD (`-f`) format, so it works on Linux and macOS hosts.
 */
export function readRemoteFileId(target: string, remotePath: string): string | null {
  const res = sshExec(
    target,
    `stat -c '%d:%i' ${remotePath} 2>/dev/null || stat -f '%d:%i' ${remotePath} 2>/dev/null`,
    { timeoutMs: 8000 },
  );
  const id = res.stdout.trim();
  return id || null;
}

/**
 * True when the local mirror file IS the very file we're tailing — the
 * localhost-as-host case, where `remoteLog` ($HOME-expanded) and `localLogPath`
 * resolve to the same inode. Appending our read bytes back into it would feed the
 * tail and multiply the log, so the caller must skip the mirror write.
 */
export function mirrorAliasesSource(localId: string | null, remoteId: string | null): boolean {
  return localId !== null && remoteId !== null && localId === remoteId;
}

/** Tail the remote log to stdout until the run finishes; return its exit code. */
export async function followHostTask(target: string, opts: FollowOptions): Promise<number> {
  const fastMs = opts.pollMs ?? 1500;
  const maxMs = Math.max(opts.maxPollMs ?? fastMs * 4, 4000);
  const deadline = Date.now() + (opts.timeoutMs ?? 3600_000);
  const local = localLogPath(opts.taskId);
  let offset = 0;
  let waitMs = fastMs;

  // localhost-as-host guard: when the local mirror and the remote log are the
  // same physical file, appending our read bytes back would feed the tail and
  // multiply the log (a plain `--host localhost` follow otherwise tripled it).
  // Detect via file identity and echo-only in that case.
  let mirror = true;
  try {
    const s = fs.statSync(local);
    if (mirrorAliasesSource(`${s.dev}:${s.ino}`, readRemoteFileId(target, opts.remoteLog))) {
      mirror = false;
    }
  } catch { /* mirror absent or unstattable → distinct file, keep mirroring */ }

  const flush = (logChunk: Buffer): boolean => {
    if (logChunk.length === 0) return false;
    if (opts.echo) process.stdout.write(logChunk);
    if (mirror) { try { fs.appendFileSync(local, logChunk); } catch { /* best-effort */ } }
    offset += logChunk.length; // exact wire bytes — no re-encode drift
    return true;
  };

  for (;;) {
    const r = fetchProgress(target, { remoteLog: opts.remoteLog, remoteExit: opts.remoteExit, taskId: opts.taskId, offset });
    const gotOutput = r ? flush(r.logChunk) : false;

    if (r && r.exit.trim() !== '') {
      // Finished — one final fetch catches bytes written between our tail and
      // the exit file appearing.
      const tail = fetchProgress(target, { remoteLog: opts.remoteLog, remoteExit: opts.remoteExit, taskId: opts.taskId, offset });
      if (tail) flush(tail.logChunk);
      const code = parseInt(r.exit.trim(), 10);
      return Number.isFinite(code) ? code : 0;
    }
    if (Date.now() > deadline) {
      process.stderr.write('\n[hosts] follow timed out; the run continues on the host. Reattach with: agents hosts logs ' + opts.taskId + ' -f\n');
      return -1;
    }

    // Fast while output flows; ease toward maxMs when idle so a quiet job isn't
    // polled needlessly. New output snaps the cadence back to fast.
    waitMs = gotOutput ? fastMs : Math.min(maxMs, Math.round(waitMs * 1.5));
    await sleep(waitMs);
  }
}
