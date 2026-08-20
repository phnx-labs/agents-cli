import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scanClaudeSessionResumable,
  scanCodexSessionResumable,
  scanClaudeSessionIncremental,
  scanCodexSessionIncremental,
  initClaudeParseState,
  initCodexParseState,
  serializeClaudeParserState,
  serializeCodexParserState,
  type ClaudeParserState,
  type CodexParserState,
} from '../discover.js';

// RUSH-2843. scanClaudeSessionResumable / scanCodexSessionResumable are the ONE
// place that decides incremental-vs-full reparse for a transcript, and until
// this file existed neither was invoked by any test: they were module-private,
// and the parity suites (incremental-parity.test.ts:283-285,
// codex-incremental-parity.test.ts:222-253) computed the branch in the TEST
// body — so they asserted that a full parse equals a full parse. The comment
// there conceded it ("the resumable contract (B-2 will wire this) is: …").
//
// Every case below drives the real function and asserts the `mode` it returned,
// so a wrong branch fails here instead of silently producing a session row that
// carries another conversation's data. Real files, real fs, no mocks.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resumable-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** A Claude transcript whose identity (first user timestamp) is `ts`. */
function claudeLines(ts: string, text: string): object[] {
  return [
    { type: 'user', timestamp: ts, cwd: '/repo', message: { role: 'user', content: text } },
    {
      type: 'assistant',
      timestamp: ts,
      message: { id: `m-${text}`, content: [{ type: 'text', text: `reply ${text}` }], usage: { input_tokens: 5, output_tokens: 2 } },
    },
  ];
}

/** A Codex rollout whose identity (session_meta payload id) is `id`. */
function codexLines(id: string, text: string): object[] {
  return [
    { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id, cwd: '/repo', model: 'gpt-5-codex' } },
    { type: 'response_item', timestamp: '2026-06-28T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
  ];
}

/** Seed a file and return the continuation a prior indexing pass would have persisted. */
async function seedClaude(fp: string, body: string): Promise<{ prior: ClaudeParserState; mtimeMs: number; size: number }> {
  fs.writeFileSync(fp, body);
  const fresh = serializeClaudeParserState(initClaudeParseState(), 0);
  const step = await scanClaudeSessionIncremental(fp, 0, fresh);
  const st = fs.statSync(fp);
  return { prior: step.newState, mtimeMs: st.mtimeMs, size: st.size };
}

async function seedCodex(fp: string, body: string): Promise<{ prior: CodexParserState; mtimeMs: number; size: number }> {
  fs.writeFileSync(fp, body);
  const fresh = serializeCodexParserState(initCodexParseState(), 0);
  const step = await scanCodexSessionIncremental(fp, 0, fresh);
  const st = fs.statSync(fp);
  return { prior: step.newState, mtimeMs: st.mtimeMs, size: st.size };
}

describe('scanClaudeSessionResumable — the full-vs-incremental decision', () => {
  it('cold start (no prior continuation) parses FULL', async () => {
    const fp = path.join(dir, 's.jsonl');
    fs.writeFileSync(fp, jsonl(claudeLines('2026-06-28T00:00:00.000Z', 'one')));
    const st = fs.statSync(fp);

    const r = await scanClaudeSessionResumable(fp, null, st.mtimeMs, st.size);
    expect(r.mode).toBe('full');
    expect(r.scan.topic).toBe('one');
  });

  it('a genuine append with an unchanged identity resumes INCREMENTALLY, matching a full reparse', async () => {
    const fp = path.join(dir, 's.jsonl');
    const seed = await seedClaude(fp, jsonl(claudeLines('2026-06-28T00:00:00.000Z', 'one')));

    fs.appendFileSync(fp, jsonl(claudeLines('2026-06-29T00:00:00.000Z', 'two')));
    const st = fs.statSync(fp);

    const inc = await scanClaudeSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(inc.mode).toBe('incremental');

    // The whole point of resuming is that it is indistinguishable from a full
    // parse of the same bytes — so compare against one.
    const full = await scanClaudeSessionResumable(fp, null, st.mtimeMs, st.size);
    expect(full.mode).toBe('full');
    expect(inc.scan).toEqual(full.scan);
    expect(inc.newOffset).toBe(full.newOffset);
  });

  it('TRUNCATION — the file shrank below the stored offset — falls back to FULL', async () => {
    const fp = path.join(dir, 's.jsonl');
    const seed = await seedClaude(fp, jsonl(claudeLines('2026-06-28T00:00:00.000Z', 'a long original prompt')));

    // A fresh, shorter session reusing the same path.
    fs.writeFileSync(fp, jsonl(claudeLines('2026-06-30T00:00:00.000Z', 'short')));
    const st = fs.statSync(fp);
    expect(st.size).toBeLessThan(seed.prior.offset);

    const r = await scanClaudeSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(r.mode).toBe('full');
    expect(r.scan.topic).toBe('short');
  });

  it('TRUNCATION with the identity UNCHANGED still falls back to FULL', async () => {
    // The case above shrinks AND changes the first turn, so the identity check
    // would force FULL on its own and the size guard is never the deciding
    // factor — verified by mutation: deleting `currentFileSize > prior.offset`
    // left that test green. Here the same session is rewritten shorter (its
    // first user turn is byte-identical), so the size guard is the ONLY thing
    // standing between a stale offset and a parse that reads past EOF.
    const fp = path.join(dir, 's.jsonl');
    const first = claudeLines('2026-06-28T00:00:00.000Z', 'kept');
    const seed = await seedClaude(fp, jsonl([...first, ...claudeLines('2026-06-28T01:00:00.000Z', 'dropped later')]));

    fs.writeFileSync(fp, jsonl(first));
    const st = fs.statSync(fp);
    expect(st.size).toBeLessThan(seed.prior.offset);

    const r = await scanClaudeSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(r.mode).toBe('full');
    expect(r.scan.topic).toBe('kept');
  });

  it('A DIFFERENT SESSION rewritten LARGER at the same path falls back to FULL', async () => {
    // The case size+mtime alone cannot catch, and the one that silently folds
    // another conversation's bytes into this row if the identity check regresses.
    const fp = path.join(dir, 's.jsonl');
    const seed = await seedClaude(fp, jsonl(claudeLines('2026-06-28T00:00:00.000Z', 'original')));

    const replacement = jsonl([
      ...claudeLines('2026-07-01T00:00:00.000Z', 'a completely different and longer conversation'),
      ...claudeLines('2026-07-01T00:05:00.000Z', 'with more turns so the file is bigger'),
    ]);
    fs.writeFileSync(fp, replacement);
    const st = fs.statSync(fp);
    expect(st.size).toBeGreaterThan(seed.prior.offset); // grew: the metadata gate would say "incremental"

    const r = await scanClaudeSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(r.mode).toBe('full');
    // and the row is the NEW session, with no trace of the old one folded in
    expect(r.scan.topic).toBe('a completely different and longer conversation');

    const full = await scanClaudeSessionResumable(fp, null, st.mtimeMs, st.size);
    expect(r.scan).toEqual(full.scan);
  });

  it('CLOCK REWIND — mtime moved backwards — falls back to FULL even though the file grew', async () => {
    const fp = path.join(dir, 's.jsonl');
    const seed = await seedClaude(fp, jsonl(claudeLines('2026-06-28T00:00:00.000Z', 'one')));

    fs.appendFileSync(fp, jsonl(claudeLines('2026-06-29T00:00:00.000Z', 'two')));
    const st = fs.statSync(fp);
    expect(st.size).toBeGreaterThan(seed.prior.offset);

    // priorFileMtimeMs is AHEAD of the file's current mtime.
    const r = await scanClaudeSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs + 60_000);
    expect(r.mode).toBe('full');
  });

  it('a prior continuation with no recorded identity falls back to FULL', async () => {
    // The file must yield NO identity either. An earlier version of this test
    // only blanked prior.timestamp and left the file with a derivable one, so
    // the *comparison* ('2026-06-28…' === undefined -> false) returned FULL and
    // the `prior.timestamp !== undefined` clause was never the deciding factor —
    // deleting that clause left the test green. With BOTH sides undefined,
    // `undefined === undefined` is TRUE, so without the clause the scan resumes
    // from a stale offset into a different session's bytes. That is reachable on
    // real data: claudeSessionIdentityAt returns undefined when no user or
    // assistant event appears within its 1 MiB budget (discover.ts:4209-4212).
    const fp = path.join(dir, 's.jsonl');
    const anonymous = (n: number) => [{ type: 'summary', summary: `preamble ${n}`, leafUuid: `u${n}` }];
    const seed = await seedClaude(fp, jsonl(anonymous(1)));
    expect(seed.prior.timestamp).toBeUndefined(); // the fixture really yields no identity

    fs.writeFileSync(fp, jsonl([...anonymous(1), ...anonymous(2), ...anonymous(3)]));
    const st = fs.statSync(fp);
    expect(st.size).toBeGreaterThan(seed.prior.offset); // grew: the metadata gate alone says "incremental"

    const r = await scanClaudeSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(r.mode).toBe('full');
  });
});

describe('scanCodexSessionResumable — the full-vs-incremental decision', () => {
  it('cold start (no prior continuation) parses FULL', async () => {
    const fp = path.join(dir, 'r.jsonl');
    fs.writeFileSync(fp, jsonl(codexLines('sess-1', 'one')));
    const st = fs.statSync(fp);

    const r = await scanCodexSessionResumable(fp, null, st.mtimeMs, st.size);
    expect(r.mode).toBe('full');
  });

  it('a genuine append with an unchanged rollout id resumes INCREMENTALLY, matching a full reparse', async () => {
    const fp = path.join(dir, 'r.jsonl');
    const seed = await seedCodex(fp, jsonl(codexLines('sess-1', 'one')));

    fs.appendFileSync(fp, jsonl([
      { type: 'response_item', timestamp: '2026-06-28T00:02:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two' }] } },
    ]));
    const st = fs.statSync(fp);

    const inc = await scanCodexSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(inc.mode).toBe('incremental');

    const full = await scanCodexSessionResumable(fp, null, st.mtimeMs, st.size);
    expect(full.mode).toBe('full');
    expect(inc.scan).toEqual(full.scan);
    expect(inc.newOffset).toBe(full.newOffset);
  });

  it('TRUNCATION — the rollout shrank below the stored offset — falls back to FULL', async () => {
    const fp = path.join(dir, 'r.jsonl');
    const seed = await seedCodex(fp, jsonl(codexLines('sess-1', 'a long original user turn')));

    fs.writeFileSync(fp, jsonl(codexLines('sess-2', 'x')));
    const st = fs.statSync(fp);
    expect(st.size).toBeLessThan(seed.prior.offset);

    const r = await scanCodexSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(r.mode).toBe('full');
  });

  it('TRUNCATION with the rollout id UNCHANGED still falls back to FULL', async () => {
    // Same reasoning as the Claude case: shrinking to a DIFFERENT rollout is
    // caught by the id check alone, so that test cannot fail when the size
    // guard is deleted. Keeping `sess-1` makes the size guard load-bearing.
    const fp = path.join(dir, 'r.jsonl');
    const first = codexLines('sess-1', 'kept');
    const seed = await seedCodex(fp, jsonl([
      ...first,
      { type: 'response_item', timestamp: '2026-06-28T01:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'dropped later' }] } },
    ]));

    fs.writeFileSync(fp, jsonl(first));
    const st = fs.statSync(fp);
    expect(st.size).toBeLessThan(seed.prior.offset);

    const r = await scanCodexSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(r.mode).toBe('full');
  });

  it('A DIFFERENT ROLLOUT rewritten LARGER at the same path falls back to FULL', async () => {
    const fp = path.join(dir, 'r.jsonl');
    const seed = await seedCodex(fp, jsonl(codexLines('sess-1', 'original')));

    fs.writeFileSync(fp, jsonl([
      ...codexLines('sess-2', 'a completely different and longer rollout'),
      { type: 'response_item', timestamp: '2026-07-01T00:05:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'with more turns so the file is bigger' }] } },
    ]));
    const st = fs.statSync(fp);
    expect(st.size).toBeGreaterThan(seed.prior.offset);

    const r = await scanCodexSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(r.mode).toBe('full');

    const full = await scanCodexSessionResumable(fp, null, st.mtimeMs, st.size);
    expect(r.scan).toEqual(full.scan);
  });

  it('CLOCK REWIND — mtime moved backwards — falls back to FULL even though the rollout grew', async () => {
    const fp = path.join(dir, 'r.jsonl');
    const seed = await seedCodex(fp, jsonl(codexLines('sess-1', 'one')));

    fs.appendFileSync(fp, jsonl([
      { type: 'response_item', timestamp: '2026-06-28T00:02:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two' }] } },
    ]));
    const st = fs.statSync(fp);
    expect(st.size).toBeGreaterThan(seed.prior.offset);

    const r = await scanCodexSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs + 60_000);
    expect(r.mode).toBe('full');
  });

  it('a prior continuation with no recorded rollout id falls back to FULL', async () => {
    // Same reasoning as the Claude twin: the rollout must yield NO id either,
    // or the id COMPARISON returns FULL and the `prior.sessionId !== undefined`
    // clause is never load-bearing. A rollout with no session_meta line never
    // sets state.sessionId (discover.ts:4399), so both sides are undefined and
    // `undefined === undefined` would flip canIncrement true without the clause.
    const fp = path.join(dir, 'r.jsonl');
    const turn = (text: string) => [
      { type: 'response_item', timestamp: '2026-06-28T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    ];
    const seed = await seedCodex(fp, jsonl(turn('one')));
    expect(seed.prior.sessionId).toBeUndefined(); // no session_meta -> no identity

    fs.writeFileSync(fp, jsonl([...turn('one'), ...turn('two'), ...turn('three')]));
    const st = fs.statSync(fp);
    expect(st.size).toBeGreaterThan(seed.prior.offset);

    const r = await scanCodexSessionResumable(fp, seed.prior, st.mtimeMs, st.size, seed.mtimeMs);
    expect(r.mode).toBe('full');
  });
});
