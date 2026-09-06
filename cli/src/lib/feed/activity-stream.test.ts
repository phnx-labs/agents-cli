import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRecentActivity } from './activity.js';
import { ActivityStream } from './activity-stream.js';

const roots: string[] = [];
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-stream-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function line(sessionId: string, detail: string, ts: string, event = 'status.posted'): string {
  return `${JSON.stringify({ v: 1, sessionId, event, ts, detail, host: 'box', runtime: 'headless' })}\n`;
}

/** Wait for a real fs.watch notification to land, bounded so a miss fails loud. */
async function settle(ms = 120): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe('incremental activity stream over real files', () => {
  it('emits exactly what readRecentActivity emits for the same appended lines', () => {
    const dir = root();
    // History the stream must never replay: it predates the cursor.
    fs.writeFileSync(path.join(dir, 'a.jsonl'), line('a', 'old-a', '2026-09-05T00:00:00.000Z'));
    fs.writeFileSync(path.join(dir, 'b.jsonl'), line('b', 'old-b', '2026-09-05T00:00:01.000Z'));
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    const stream = new ActivityStream({ root: dir, watch: false });

    // Appended out of timestamp order and across files, so ordering is a real assertion.
    fs.appendFileSync(path.join(dir, 'a.jsonl'), line('a', 'a-2', '2026-09-06T00:00:02.000Z'));
    fs.appendFileSync(path.join(dir, 'b.jsonl'), line('b', 'b-1', '2026-09-06T00:00:01.000Z'));
    fs.appendFileSync(path.join(dir, 'a.jsonl'), line('a', 'a-3', '2026-09-06T00:00:03.000Z'));
    fs.writeFileSync(path.join(dir, 'c.jsonl'), line('c', 'c-1', '2026-09-06T00:00:00.000Z'));

    const streamed = stream.read(sinceMs);
    const oneShot = readRecentActivity({ root: dir, sinceMs });
    expect(streamed).toEqual(oneShot);
    expect(streamed.map((event) => event.detail)).toEqual(['a-3', 'a-2', 'b-1', 'c-1']);
    stream.close();
  });

  it('reads only the appended bytes, not the corpus, across a thousand session logs', () => {
    const dir = root();
    for (let i = 0; i < 1_000; i++) {
      fs.writeFileSync(path.join(dir, `s${i}.jsonl`), line(`s${i}`, `seed-${i}`, '2026-09-05T00:00:00.000Z'));
    }
    const corpusBytes = fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
    expect(corpusBytes).toBeGreaterThan(100_000);

    const stream = new ActivityStream({ root: dir, watch: false });
    // The opening scan stats every log and opens none of them.
    expect(stream.bytesRead).toBe(0);

    const appended = line('s7', 'live', '2026-09-06T00:00:00.000Z');
    fs.appendFileSync(path.join(dir, 's7.jsonl'), appended);
    const events = stream.read(Date.parse('2026-09-06T00:00:00.000Z'));
    expect(events.map((event) => event.detail)).toEqual(['live']);
    expect(stream.bytesRead).toBe(Buffer.byteLength(appended));

    // An idle tick over the same thousand logs reads nothing at all.
    const before = stream.bytesRead;
    expect(stream.read(Date.parse('2026-09-06T00:00:00.000Z'))).toEqual([]);
    expect(stream.bytesRead).toBe(before);
    stream.close();
  });

  it('holds a half-written line until its newline arrives, and emits it exactly once', () => {
    const dir = root();
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, '');
    const stream = new ActivityStream({ root: dir, watch: false });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    const record = line('s', 'torn', '2026-09-06T00:00:00.000Z');

    fs.appendFileSync(file, record.slice(0, 20));
    expect(stream.read(sinceMs)).toEqual([]);
    fs.appendFileSync(file, record.slice(20));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['torn']);
    // No duplicate on the next tick.
    expect(stream.read(sinceMs)).toEqual([]);
    stream.close();
  });

  it('recovers from an in-place rewrite, truncation, atomic replacement, deletion, and a log created later', () => {
    const dir = root();
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, line('s', 'seed', '2026-09-05T00:00:00.000Z'));
    const stream = new ActivityStream({ root: dir, watch: false });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    fs.appendFileSync(file, line('s', 'appended', '2026-09-06T00:00:00.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['appended']);

    // Rewritten in place to a LONGER file: growth alone would read the tail as
    // an append and parse the middle of a record. The bytes behind the cursor
    // no longer match, so the file restarts instead.
    fs.writeFileSync(file, line('s', 'rewritten-in-place-and-longer', '2026-09-06T00:00:01.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['rewritten-in-place-and-longer']);

    // Truncated below the cursor: the shorter file is re-read from its start.
    fs.writeFileSync(file, line('s', 'short', '2026-09-06T00:00:02.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['short']);

    // Atomic replacement (new inode, same path).
    const staged = path.join(dir, 'staged');
    fs.writeFileSync(staged, line('s', 'replaced', '2026-09-06T00:00:03.000Z'));
    fs.renameSync(staged, file);
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['replaced']);

    // A log created after the opening scan is new work, so it IS read.
    fs.writeFileSync(path.join(dir, 'new.jsonl'), line('new', 'fresh', '2026-09-06T00:00:04.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['fresh']);

    fs.unlinkSync(file);
    expect(stream.read(sinceMs)).toEqual([]);
    stream.close();
  });

  it('keeps only the newest bytes when one tick appends more than the read budget', () => {
    const dir = root();
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, '');
    const stream = new ActivityStream({ root: dir, watch: false, maxBytesPerRead: 400 });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    const burst = Array.from({ length: 20 }, (_, i) => line('s', `burst-${i}`, `2026-09-06T00:00:${String(i).padStart(2, '0')}.000Z`)).join('');
    expect(Buffer.byteLength(burst)).toBeGreaterThan(400);
    fs.appendFileSync(file, burst);
    const details = stream.read(sinceMs).map((event) => event.detail);
    // Bounded like readRecentActivity's tail: the newest records survive, the
    // partial leading record is dropped rather than parsed as garbage.
    expect(details.length).toBeGreaterThan(0);
    expect(details[0]).toBe('burst-19');
    expect(stream.bytesRead).toBeLessThanOrEqual(400);
    stream.close();
  });

  it('picks up an appended log through the directory watcher without sweeping every tick', async () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 's.jsonl'), line('s', 'seed', '2026-09-05T00:00:00.000Z'));
    // A sweep cadence far beyond the test window, so a hit here proves the
    // watcher — not the fallback poll — delivered the change.
    const stream = new ActivityStream({ root: dir, sweepMs: 3_600_000 });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    fs.appendFileSync(path.join(dir, 's.jsonl'), line('s', 'watched', '2026-09-06T00:00:00.000Z'));
    await settle();
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['watched']);
    stream.close();
  });
});
