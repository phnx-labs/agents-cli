import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-timeline-pass-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata');
const CLAUDE_FIXTURE = path.join(TESTDATA, 'timeline-claude.jsonl');

let db: typeof import('./db.js');
let pass: typeof import('./timeline-pass.js');
let timeline: typeof import('./timeline.js');
type ActiveSession = import('./active.js').ActiveSession;

/** A live row shaped exactly as the daemon's gather produces it. */
function row(sessionId: string, sessionFile: string, kind = 'claude'): ActiveSession {
  return { context: 'terminal', kind, sessionId, sessionFile, status: 'running', activity: 'working' } as ActiveSession;
}

beforeAll(async () => {
  db = await import('./db.js');
  pass = await import('./timeline-pass.js');
  timeline = await import('./timeline.js');
  db.getDB();
});

afterAll(() => {
  db.closeDB();
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('runTimelinePass — the daemon\'s incremental fold', () => {
  it('folds a live transcript, caches it, and reuses the cache when nothing was appended', () => {
    const file = path.join(tmpHome, 'live-a.jsonl');
    const lines = fs.readFileSync(CLAUDE_FIXTURE, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, `${lines.slice(0, 200).join('\n')}\n`);

    const first = pass.runTimelinePassSync({ sessions: [row('live-a', file)] });
    expect(first).toMatchObject({ computed: 1, reused: 0, skipped: 0 });

    const stored = db.readSessionTimelineAny('live-a');
    expect(stored?.timeline.steps.length).toBeGreaterThan(0);
    expect(stored?.timeline.state).toBe('ready');
    expect(stored?.request?.headline).toBeTruthy();
    // The newest step is live because the row's activity is `working`.
    expect(stored!.timeline.steps[stored!.timeline.steps.length - 1].live).toBe(true);

    // Nothing appended → no re-fold.
    expect(pass.runTimelinePassSync({ sessions: [row('live-a', file)] })).toMatchObject({ computed: 0, reused: 1 });
  });

  it('reads only the appended bytes, and the result equals folding the whole file', () => {
    const file = path.join(tmpHome, 'live-b.jsonl');
    const lines = fs.readFileSync(CLAUDE_FIXTURE, 'utf8').split('\n').filter(Boolean);
    const head = `${lines.slice(0, 150).join('\n')}\n`;
    fs.writeFileSync(file, head);
    pass.runTimelinePassSync({ sessions: [row('live-b', file)] });
    const afterHead = db.readSessionTimelineEntry('live-b')!;
    expect(afterHead.state.offset).toBe(Buffer.byteLength(head));

    // Append the rest, exactly as a running agent would.
    fs.appendFileSync(file, `${lines.slice(150).join('\n')}\n`);
    pass.runTimelinePassSync({ sessions: [row('live-b', file)] });
    const resumed = db.readSessionTimelineEntry('live-b')!;
    expect(resumed.state.offset).toBe(fs.statSync(file).size);

    // A cold session over the identical bytes must agree with the resumed one.
    const cold = path.join(tmpHome, 'cold-b.jsonl');
    fs.copyFileSync(file, cold);
    pass.runTimelinePassSync({ sessions: [row('cold-b', cold)] });
    const whole = db.readSessionTimelineEntry('cold-b')!;
    expect(resumed.timeline).toEqual(whole.timeline);
    expect(resumed.request).toEqual(whole.request);
    expect(resumed.files).toEqual(whole.files);
  });

  it('never folds a record that is still being written, and folds it whole once it lands', () => {
    const file = path.join(tmpHome, 'straddle.jsonl');
    const complete = JSON.stringify({
      type: 'assistant', timestamp: '2026-09-06T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First beat of the run.' }] },
    });
    // A partial second record: a 200 KB line with no trailing newline yet — the
    // shape a 973,963-byte transcript record has mid-write.
    const partial = JSON.stringify({
      type: 'assistant', timestamp: '2026-09-06T00:00:10.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `Second beat. ${'x'.repeat(200_000)}` }] },
    });
    fs.writeFileSync(file, `${complete}\n${partial.slice(0, 120_000)}`);
    pass.runTimelinePassSync({ sessions: [row('straddle', file)] });
    let stored = db.readSessionTimelineEntry('straddle')!;
    expect(stored.timeline.steps).toHaveLength(1);
    expect(stored.state.offset).toBe(Buffer.byteLength(`${complete}\n`));

    // The writer finishes the record.
    fs.writeFileSync(file, `${complete}\n${partial}\n`);
    pass.runTimelinePassSync({ sessions: [row('straddle', file)] });
    stored = db.readSessionTimelineEntry('straddle')!;
    expect(stored.timeline.steps).toHaveLength(2);
    expect(stored.timeline.steps[1].text.startsWith('Second beat.')).toBe(true);
    expect(stored.state.offset).toBe(fs.statSync(file).size);
  });

  it('stops at the per-tick BYTE budget, so a cold cache catches up over ticks', () => {
    // The per-session cap alone is not a bound on the tick: eight live sessions
    // folding from offset 0 is eight whole-file parses in one 30 s deadline,
    // which is what parked `session-state` on this fleet before this budget.
    const line = (n: number) => `${JSON.stringify({
      type: 'assistant', timestamp: '2026-09-06T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `Beat ${n}. ${'x'.repeat(4000)}` }] },
    })}\n`;
    const rows = ['w1', 'w2', 'w3'].map((id) => {
      const file = path.join(tmpHome, `${id}.jsonl`);
      fs.writeFileSync(file, line(1).repeat(3));
      return row(id, file);
    });
    const size = fs.statSync(rows[0].sessionFile!).size;
    // A budget that admits the first session's bytes and little more.
    const result = pass.runTimelinePassSync({ sessions: rows, maxBytes: size + 10 });
    expect(result.computed).toBe(1);
    expect(db.readSessionTimelineAny('w2')).toBeUndefined();

    // The next tick, with a fresh budget, picks the rest up.
    expect(pass.runTimelinePassSync({ sessions: rows }).computed).toBe(2);
    expect(db.readSessionTimelineAny('w3')).toBeDefined();
  });

  it('stops at the per-tick session budget so one tick can never own the daemon', () => {
    const files = ['b1', 'b2', 'b3'].map((id) => {
      const file = path.join(tmpHome, `${id}.jsonl`);
      fs.writeFileSync(file, `${JSON.stringify({
        type: 'assistant', timestamp: '2026-09-06T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `Beat for ${id}.` }] },
      })}\n`);
      return row(id, file);
    });
    const result = pass.runTimelinePassSync({ sessions: files, budget: 2 });
    expect(result.computed).toBe(2);
    expect(db.readSessionTimelineAny('b3')).toBeUndefined();
  });

  it('re-parses a non-resumable harness at most once a minute, never every tick', () => {
    // Kimi/Grok expose no resume offset, so their only option is a whole-file
    // parse — the operation that wedged the event loop in PHNX-3411. The pass
    // rate-limits it instead of paying it on every 15 s tick.
    const dir = fs.mkdtempSync(path.join(tmpHome, 'kimi-'));
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
    const state = path.join(dir, 'state.json');
    const line = (text: string, at: number) => `${JSON.stringify({
      type: 'context.append_loop_event', time: at,
      event: { type: 'content.part', part: { type: 'text', text } },
    })}\n`;
    fs.writeFileSync(wire, line('First beat of the kimi run.', Date.UTC(2026, 8, 6)));
    fs.writeFileSync(state, '{}');

    const kimi = { ...row('kimi-1', state, 'kimi'), activity: 'working' } as ActiveSession;
    expect(pass.runTimelinePassSync({ sessions: [kimi], nowMs: 1_000_000 })).toMatchObject({ computed: 1 });

    // A tick 15 s later with new bytes: within the interval, so the cached row
    // stands and no parse happens.
    fs.appendFileSync(wire, line('Second beat of the kimi run.', Date.UTC(2026, 8, 6, 0, 0, 30)));
    expect(pass.runTimelinePassSync({ sessions: [kimi], nowMs: 1_015_000 }))
      .toMatchObject({ computed: 0, reused: 1, skipped: 0 });
    expect(db.readSessionTimelineAny('kimi-1')!.timeline.steps).toHaveLength(1);

    // Past the interval, it re-parses and picks the new beat up.
    expect(pass.runTimelinePassSync({ sessions: [kimi], nowMs: 1_000_000 + pass.TIMELINE_PASS_NON_RESUMABLE_MIN_INTERVAL_MS + 1 }))
      .toMatchObject({ computed: 1 });
    expect(db.readSessionTimelineAny('kimi-1')!.timeline.steps).toHaveLength(2);
  });

  it('skips a session with no transcript on disk instead of throwing', () => {
    const result = pass.runTimelinePassSync({ sessions: [row('gone', path.join(tmpHome, 'nope.jsonl'))] });
    expect(result).toMatchObject({ computed: 0, skipped: 1 });
  });

  it('states a harness with no parseable transcript as unavailable, never as an empty timeline', () => {
    const file = path.join(tmpHome, 'openclaw.jsonl');
    fs.writeFileSync(file, '{}\n');
    pass.runTimelinePassSync({ sessions: [row('claw', file, 'openclaw')] });
    const stored = db.readSessionTimelineAny('claw')!;
    expect(stored.timeline.state).toBe('unavailable');
    expect(stored.timeline.reason).toContain('OpenClaw');
  });

  it('is reader-gated: no watcher attached, no work', async () => {
    const result = await pass.runTimelinePass({ nowMs: 0 });
    expect(result).toEqual({ computed: 0, reused: 0, skipped: 0 });
  });

  it('does not fold a peer mirror\'s stored projection onto a local byte offset', () => {
    // A mirrored peer row carries a projection with an EMPTY resume state, so
    // this box can never resume-fold a transcript it does not have.
    db.writeSessionTimeline({
      id: 'peer-1', fileMtimeMs: null, fileSize: null,
      timeline: {
        timeline: timeline.projectTimeline(timeline.emptyTimelineState(), undefined),
        state: timeline.emptyTimelineState(),
      },
    });
    expect(db.readSessionTimelineEntry('peer-1')!.state.offset).toBe(0);
  });
});
