/**
 * Incremental reader for the activity log directory.
 *
 * `readRecentActivity` answers "what happened since T?" by tailing and parsing
 * every session log in the directory. That is the right shape for a one-shot
 * `agents feed` render and the wrong shape for `agents feed watch`, which asks
 * the same question twice a second for as long as a VS Code window is open: on
 * a real operator box the directory holds 1,437 logs / 64 MB, so every tick
 * re-read and re-parsed the whole corpus to emit, almost always, nothing.
 *
 * This reader keeps a per-file cursor instead. The opening scan opens no files
 * at all — it records each log's size, inode, and mtime — so only bytes appended
 * *after* the stream started are ever read. Steady-state cost is one `stat` per
 * changed file plus a parse of exactly the appended bytes.
 *
 * The emitted events, their order, and the `sinceMs` filter match
 * `readRecentActivity` for everything appended while the stream is open; the
 * equivalence is pinned by `activity-stream.test.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getActivityDir } from '../state.js';
import { ACTIVITY_TAIL_BYTES, parseActivityLine, type ActivityEvent } from './activity.js';

/** How often the stream falls back to a full directory stat sweep. */
export const ACTIVITY_SWEEP_MS = 5_000;
/** Upper bound on the per-file cursors held in memory. */
export const ACTIVITY_MAX_TRACKED_FILES = 8_192;
/** Bytes behind the cursor re-verified before appended bytes are trusted. */
export const ACTIVITY_ANCHOR_BYTES = 64;

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

interface FileCursor {
  /** `dev:ino` of the tracked inode; a change means the path was replaced. */
  identity: string;
  /** Bytes of this inode already consumed. */
  offset: number;
  /** Trailing bytes after the last newline, waiting for the line to finish. */
  partial: Buffer;
  /** True when `partial` starts mid-record and must not be parsed. */
  partialIsFragment: boolean;
  /**
   * The last {@link ACTIVITY_ANCHOR_BYTES} bytes already consumed, once this
   * reader has actually read from the file. Growth alone cannot tell an append
   * from an in-place rewrite that happens to be longer, so those bytes are
   * re-verified — they ride the same read, at no extra syscall — and a mismatch
   * restarts the file rather than parsing the middle of a record.
   */
  anchor: Buffer;
  /** Last observed size and mtime, so an untouched file is never opened. */
  size: number;
  mtimeMs: number;
}

export interface ActivityStreamOptions {
  /** Override the activity dir (tests). */
  root?: string;
  /**
   * Newest bytes read from one file in one tick. A burst larger than this keeps
   * only the tail, exactly as `readRecentActivity`'s bounded tail does.
   */
  maxBytesPerRead?: number;
  /** Full stat sweep cadence, covering anything the directory watcher misses. */
  sweepMs?: number;
  /** Cursor budget; the least recently modified logs are dropped past it. */
  maxTrackedFiles?: number;
  /** Subscribe to directory change notifications (default true). */
  watch?: boolean;
}

/**
 * A cursor over the activity directory. Construct it at the moment the caller's
 * activity cursor starts, then call {@link read} once per tick.
 */
export class ActivityStream {
  private readonly dir: string;
  private readonly maxBytesPerRead: number;
  private readonly sweepMs: number;
  private readonly maxTrackedFiles: number;
  private readonly cursors = new Map<string, FileCursor>();
  private readonly dirty = new Set<string>();
  private watcher?: fs.FSWatcher;
  private watchRequested: boolean;
  private lastSweepMs = 0;
  /** False during the opening scan, so it registers history without reading it. */
  private started = false;
  /** Bytes read from activity logs since construction. Observability + tests. */
  bytesRead = 0;

  constructor(options: ActivityStreamOptions = {}) {
    this.dir = options.root ?? getActivityDir();
    this.maxBytesPerRead = options.maxBytesPerRead ?? ACTIVITY_TAIL_BYTES;
    this.sweepMs = options.sweepMs ?? ACTIVITY_SWEEP_MS;
    this.maxTrackedFiles = options.maxTrackedFiles ?? ACTIVITY_MAX_TRACKED_FILES;
    this.watchRequested = options.watch ?? true;
    this.sweep(Date.now());
    this.armWatcher();
  }

  /**
   * Events appended since the last call, newest first, filtered to `sinceMs`
   * inclusive — the same shape and order `readRecentActivity({ sinceMs })`
   * returns for those events.
   */
  read(sinceMs: number, nowMs = Date.now()): ActivityEvent[] {
    const out: ActivityEvent[] = [];
    for (const name of this.candidates(nowMs)) {
      for (const event of this.readFile(name)) {
        const at = Date.parse(event.ts);
        if (Number.isFinite(at) && at >= sinceMs) out.push(event);
      }
    }
    out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return out;
  }

  /** Release the directory watcher. Safe to call more than once. */
  close(): void {
    this.watchRequested = false;
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** Which log names could have changed since the previous tick. */
  private candidates(nowMs: number): string[] {
    // A watcher that never armed (unsupported filesystem, or a directory that
    // did not exist at construction) means every tick sweeps. That is the
    // fallback: never a silent no-op that would drop events.
    if (!this.watcher) this.armWatcher();
    if (!this.watcher || nowMs - this.lastSweepMs >= this.sweepMs) this.sweep(nowMs);
    const names = [...this.dirty];
    this.dirty.clear();
    return names;
  }

  /**
   * Stat every log, marking the ones that could have changed. Opens nothing: a
   * log the opening scan sees is registered past its own bytes, so history is
   * never replayed onto the stream.
   */
  private sweep(nowMs: number): void {
    this.lastSweepMs = nowMs;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return; // The directory appears with the first logged event.
    }
    const seen = new Set<string>();
    for (const name of names) {
      seen.add(name);
      const stat = this.statOf(name);
      if (!stat) continue;
      const cursor = this.cursors.get(name);
      if (!cursor) {
        // A log first seen after the opening scan is new work: left
        // unregistered so `readFile` opens it from a bounded tail.
        if (this.started) this.dirty.add(name);
        else this.cursors.set(name, {
          identity: stat.identity, offset: stat.size, partial: EMPTY, partialIsFragment: false,
          anchor: EMPTY, size: stat.size, mtimeMs: stat.mtimeMs,
        });
        continue;
      }
      if (stat.identity !== cursor.identity || stat.size !== cursor.size || stat.mtimeMs !== cursor.mtimeMs) this.dirty.add(name);
    }
    for (const name of [...this.cursors.keys()]) if (!seen.has(name)) this.cursors.delete(name);
    this.evict();
    this.started = true;
  }

  private statOf(name: string): { identity: string; size: number; mtimeMs: number } | undefined {
    try {
      const st = fs.statSync(path.join(this.dir, name), { bigint: true });
      return { identity: `${st.dev}:${st.ino}`, size: Number(st.size), mtimeMs: Number(st.mtimeNs) };
    } catch {
      return undefined; // Deleted between readdir and stat.
    }
  }

  /** A cursor starting at a bounded tail of the file as it stands right now. */
  private freshCursor(stat: { identity: string; size: number; mtimeMs: number }): FileCursor {
    const offset = Math.max(0, stat.size - this.maxBytesPerRead);
    return {
      identity: stat.identity, offset, partial: EMPTY, partialIsFragment: offset > 0,
      anchor: EMPTY, size: stat.size, mtimeMs: stat.mtimeMs,
    };
  }

  /** Read and parse only the bytes appended to one log since its cursor. */
  private readFile(name: string, restarted = false): ActivityEvent[] {
    const stat = this.statOf(name);
    if (!stat) { this.cursors.delete(name); return []; }
    let cursor = this.cursors.get(name);
    // Unseen, replaced, or truncated: restart from a bounded tail of the file as
    // it now stands. The caller's `sinceMs` drops whatever predates the stream.
    if (!cursor || cursor.identity !== stat.identity || stat.size < cursor.offset) {
      cursor = this.freshCursor(stat);
      this.cursors.set(name, cursor);
    }
    cursor.size = stat.size;
    cursor.mtimeMs = stat.mtimeMs;
    if (stat.size <= cursor.offset) return [];
    // A burst larger than the budget keeps the newest bytes; the skipped span is
    // exactly what the bounded-tail reader would have dropped as well.
    const start = Math.max(cursor.offset, stat.size - this.maxBytesPerRead);
    if (start > cursor.offset) {
      cursor.partial = EMPTY;
      cursor.partialIsFragment = true;
      cursor.anchor = EMPTY;
    }
    const verify = Math.min(cursor.anchor.length, start);
    const buf = this.readRange(name, start - verify, stat.size - start + verify);
    if (buf === undefined) return []; // Transient I/O error: retry next tick.
    if (verify > 0 && !buf.subarray(0, verify).equals(cursor.anchor.subarray(cursor.anchor.length - verify))) {
      // The bytes behind the cursor changed, so this file was rewritten rather
      // than appended to. Restart it once from a bounded tail.
      if (restarted) return [];
      this.cursors.delete(name);
      return this.readFile(name, true);
    }
    const fresh = buf.subarray(verify);
    cursor.offset = stat.size;
    cursor.anchor = Buffer.concat([cursor.anchor, fresh]).subarray(-ACTIVITY_ANCHOR_BYTES);
    const chunk = Buffer.concat([cursor.partial, fresh]);
    const fragment = cursor.partialIsFragment;
    const end = chunk.lastIndexOf(NEWLINE);
    // Hold an unterminated trailing line: the writer appends whole
    // newline-terminated records (`appendActivityEvent`), so a tail without a
    // newline is a write in progress and completes on a later tick.
    cursor.partial = end < 0 ? chunk : chunk.subarray(end + 1);
    cursor.partialIsFragment = end < 0 ? fragment : false;
    if (end < 0) return [];
    const lines = chunk.subarray(0, end).toString('utf-8').split('\n');
    // A range that began mid-file starts inside a record; that leading fragment
    // is not one, exactly as the bounded-tail reader drops it.
    if (fragment) lines.shift();
    const events: ActivityEvent[] = [];
    for (const line of lines) {
      const event = parseActivityLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  private readRange(name: string, start: number, length: number): Buffer | undefined {
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(this.dir, name), 'r');
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      this.bytesRead += read;
      return buf.subarray(0, read);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private armWatcher(): void {
    if (!this.watchRequested || this.watcher) return;
    try {
      this.watcher = fs.watch(this.dir, (_event, name) => {
        if (typeof name === 'string' && name.endsWith('.jsonl')) this.dirty.add(name);
      });
      // A watch error (the directory is removed) degrades to sweeping rather
      // than taking down the watcher process.
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
    } catch {
      this.watcher = undefined;
    }
  }

  /** Keep the cursor map bounded; the least recently modified logs go first. */
  private evict(): void {
    if (this.cursors.size <= this.maxTrackedFiles) return;
    const byAge = [...this.cursors.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
    for (const [name] of byAge.slice(0, this.cursors.size - this.maxTrackedFiles)) this.cursors.delete(name);
  }
}
