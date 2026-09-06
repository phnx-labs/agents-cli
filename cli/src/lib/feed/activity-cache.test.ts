import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRecentActivity, readSessionActivity } from './activity.js';

const roots: string[] = [];
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-cache-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function line(detail: string, ts = '2026-09-06T00:00:00Z', event = 'status.posted') {
  return JSON.stringify({ sessionId: 's', event, ts, detail, attachments: [{ href: 'a', meta: { n: 1 } }] });
}

describe('activity tail cache with real files', () => {
  it('tracks append, partial completion, truncation, restored-mtime rewrite, replacement, deletion and creation', () => {
    const dir = root(); const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, line('a') + '\n');
    const read = () => readRecentActivity({ root: dir }).map(e => e.detail);
    expect(read()).toEqual(['a']);
    fs.appendFileSync(file, line('b').slice(0, -2));
    expect(read()).toEqual(['a']);
    fs.appendFileSync(file, line('b').slice(-2)); // valid final JSON without newline
    expect(read()).toEqual(['a', 'b']);
    fs.writeFileSync(file, line('c'));
    expect(read()).toEqual(['c']);
    const st = fs.statSync(file);
    fs.writeFileSync(file, line('d'));
    fs.utimesSync(file, st.atime, st.mtime);
    expect(read()).toEqual(['d']);
    fs.writeFileSync(path.join(dir, 'replacement'), line('e'));
    fs.renameSync(path.join(dir, 'replacement'), file);
    expect(read()).toEqual(['e']);
    fs.unlinkSync(file);
    expect(read()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'new.jsonl'), line('f'));
    expect(read()).toEqual(['f']);
  });

  it('preserves filter-before-limit, inclusive timestamps, invalid dates, unsorted timestamps and mutable results', () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 's.jsonl'), [line('new', '2026-09-07'), line('bad', 'invalid'), line('old', '2026-09-06'), line('routine', '2026-09-08', 'file.edited')].join('\n'));
    const options = { root: dir, sinceMs: Date.parse('2026-09-06'), events: ['status.posted'], tier: 'milestone' as const, limit: 2 };
    const events = readRecentActivity(options);
    expect(events.map(e => e.detail)).toEqual(['new', 'old']);
    events[0].detail = 'mutated'; events[0].attachments![0].meta!.n = 9;
    expect(readRecentActivity(options)[0]).toMatchObject({ detail: 'new', attachments: [{ meta: { n: 1 } }] });
    const session = readSessionActivity('s', dir); session[0].attachments![0].href = 'mutated';
    expect(readSessionActivity('s', dir)[0].attachments![0].href).toBe('a');
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-09') })).toEqual([]);
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-08') }).map(e => e.detail)).toEqual(['routine']);
  });

  it('keys tail budgets and directories separately and drops the leading partial line exactly as before', () => {
    const a = root(); const b = root(); const text = line('a') + '\n' + line('b') + '\n';
    fs.writeFileSync(path.join(a, 's.jsonl'), text);
    fs.writeFileSync(path.join(b, 's.jsonl'), line('other'));
    expect(readSessionActivity('s', a).map(e => e.detail)).toEqual(['a', 'b']);
    expect(readSessionActivity('s', a, Buffer.byteLength(line('b')) + 2).map(e => e.detail)).toEqual(['b']);
    expect(readSessionActivity('s', a, 5)).toEqual([]);
    expect(readSessionActivity('s', b).map(e => e.detail)).toEqual(['other']);
    expect(readSessionActivity('s', a).map(e => e.detail)).toEqual(['a', 'b']);
  });
  it('does not convert malformed timestamp objects before event filters or during session reads', () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify({ sessionId: 's', event: 'file.edited', ts: { toString: 'bad' } }));
    expect(readSessionActivity('s', dir)).toHaveLength(1);
    expect(readRecentActivity({ root: dir, events: ['status.posted'] })).toEqual([]);
    expect(readRecentActivity({ root: dir, tier: 'milestone' })).toEqual([]);
    expect(() => readRecentActivity({ root: dir })).toThrow(TypeError);
  });

  it('rehydrates tails after memory pressure and entry eviction without hiding older events', () => {
    const dir = root();
    // More than the retained parsed-tail budget, with each file below its tail
    // byte budget. Summary-only entries must support a later, earlier cursor.
    const text = Array.from({ length: 1000 }, (_, i) => line(String(i))).join('\n');
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `s${i}.jsonl`), text);
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-07') })).toEqual([]);
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-06'), limit: 2 }).map(e => e.detail)).toEqual(['0', '1']);
    expect(readSessionActivity('s0', dir)).toHaveLength(1000);
    const other = root();
    for (let i = 0; i < 1030; i++) {
      fs.writeFileSync(path.join(other, `s${i}.jsonl`), line(String(i)));
      expect(readSessionActivity(`s${i}`, other)[0].detail).toBe(String(i));
    }
    expect(readSessionActivity('s0', dir)).toHaveLength(1000);
    expect(readSessionActivity('s0', other)[0].detail).toBe('0');
  });

});
