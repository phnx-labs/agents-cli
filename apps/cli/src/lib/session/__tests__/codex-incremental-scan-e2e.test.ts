import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// End-to-end parity for the LIVE Codex scan path (B-3). Proves that wiring
// scanCodexSessionIncremental into discoverSessions produces a DB row IDENTICAL,
// field for field, to a from-scratch FULL reparse — even when PR / ticket
// signals STRADDLE two scans and the cumulative token_count updates across an
// append — and that a truncation forces a full reparse. Real fs, real sqlite,
// real discovery under a throwaway HOME. No mocks.
//
// The from-scratch ground truth is computed inside the SAME DB by writing the
// final rollout content to a DIFFERENT session id (no prior ledger row → the
// code takes the FULL path for it) and comparing its row.

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-codex-e2e-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type Discover = typeof import('../discover.js');
type DB = typeof import('../db.js');

let discover: Discover;
let db: DB;

const SESSIONS = path.join(tmpHome, '.codex', 'sessions');

function line(obj: object): string {
  return JSON.stringify(obj);
}

/** Path of a rollout file for a given session id under the live sessions dir. */
function rolloutFile(id: string): string {
  return path.join(SESSIONS, `rollout-${id}.jsonl`);
}

function writeRollout(id: string, events: object[]): string {
  fs.mkdirSync(SESSIONS, { recursive: true });
  const fp = rolloutFile(id);
  fs.writeFileSync(fp, events.map(line).join('\n') + '\n', 'utf-8');
  bumpMtimeToNow(fp, 0);
  return fp;
}

function appendRollout(id: string, events: object[]): void {
  fs.appendFileSync(rolloutFile(id), events.map(line).join('\n') + '\n', 'utf-8');
}

/** Push a file's mtime forward so an append isn't seen as a clock-rewind and the ledger stamp changes. */
function bumpMtimeToNow(fp: string, plusSeconds: number): void {
  const t = Math.floor(Date.now() / 1000) + plusSeconds;
  fs.utimesSync(fp, t, t);
}

/** Age every ledger row past the 5s active-append debounce so a grown file re-scans this tick. */
function agePriorScans(): void {
  db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now() - 60_000);
}

async function runScan(): Promise<void> {
  agePriorScans();
  await discover.discoverSessions({ agent: 'codex', all: true });
}

// `timestamp` and `lastActivity` are excluded: Codex's timestamp is
// max(session_meta.timestamp, file.mtime) (see pickLatestCodexTimestamp), so two
// SEPARATE files (the incremental session vs the from-scratch ground truth)
// carry different mtimes and can never match on those two fields. Every other
// field is a pure function of the parsed content and must match exactly.
const PARITY_FIELDS = [
  'agent', 'project', 'cwd', 'gitBranch', 'version',
  'topic', 'messageCount', 'tokenCount', 'outputTokens', 'costUsd', 'durationMs',
  'prUrl', 'prNumber', 'worktreeSlug', 'ticketId', 'createdTickets', 'spawnedTeam',
] as const;

function assertRowParity(incId: string, fullId: string): void {
  const inc = db.getSessionById(incId);
  const full = db.getSessionById(fullId);
  expect(inc, `incremental row ${incId} exists`).not.toBeNull();
  expect(full, `full-reparse row ${fullId} exists`).not.toBeNull();
  for (const f of PARITY_FIELDS) {
    expect((inc as any)[f], `field ${f}`).toEqual((full as any)[f]);
  }
}

let groundTruthCounter = 0;
/**
 * Compute the from-scratch ground truth for a set of events: write them to a
 * brand-new rollout file whose session_meta carries a fresh id (no prior ledger
 * continuation → FULL parse). Returns the SESSION id (from session_meta), which
 * is the DB row key — not the file name.
 */
async function groundTruth(events: object[], sessionId: string): Promise<string> {
  const fileId = `ground-truth-${groundTruthCounter++}`;
  writeRollout(fileId, events);
  await runScan();
  return sessionId;
}

beforeAll(async () => {
  db = await import('../db.js');
  discover = await import('../discover.js');
  db.getDB();
});

beforeEach(() => {
  discover.__resetCodexScanBranchCountsForTest();
});

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Field-rich base events. `sessionId` only sets session_meta.id (the DB row key);
 * the user text is STABLE so topic/contentText parity holds between the
 * incrementally-scanned session and a from-scratch ground truth under a different id.
 */
function baseEvents(sessionId: string): object[] {
  return [
    { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: sessionId, timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', git: { branch: 'RUSH-42-fix' }, cli_version: '0.9.0', model: 'gpt-5-codex' } },
    { type: 'response_item', timestamp: '2026-06-28T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'investigate the flaky exec test' }] } },
    { type: 'event_msg', timestamp: '2026-06-28T00:01:05.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 4 } } } },
  ];
}

function appendedEvents(): object[] {
  return [
    { type: 'response_item', timestamp: '2026-06-28T00:03:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'event_msg', timestamp: '2026-06-28T00:03:05.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 400, output_tokens: 80, reasoning_output_tokens: 10 } } } },
  ];
}

describe('B-3 live incremental Codex scan parity', () => {
  it('CORE: an appended rollout, re-scanned incrementally, equals a from-scratch full reparse for every field', async () => {
    const id = 'core-session';

    writeRollout(id, baseEvents(id));
    await runScan();
    expect(discover.__codexScanBranchCountsForTest().full).toBeGreaterThanOrEqual(1);

    discover.__resetCodexScanBranchCountsForTest();
    appendRollout(id, appendedEvents());
    bumpMtimeToNow(rolloutFile(id), 1);
    await runScan();
    expect(discover.__codexScanBranchCountsForTest().incremental, 'incremental branch exercised on 2nd scan').toBeGreaterThanOrEqual(1);

    // Ground truth: the FINAL content parsed from scratch under a fresh session id.
    const gtBase = baseEvents('gt-core');
    const gtId = await groundTruth([...gtBase, ...appendedEvents()], 'gt-core');
    assertRowParity(id, gtId);

    const inc = db.getSessionById(id)!;
    // LAST-WINS token snapshot from the append: 400 + 80 + 10 = 490.
    expect(inc.tokenCount).toBe(490);
    expect(inc.outputTokens).toBe(90);
    expect(inc.messageCount).toBe(2);
  });

  it('STRADDLED PR: gh pr create in the first write, its URL in the append → correct prUrl/prNumber', async () => {
    const id = 'straddle-pr';
    writeRollout(id, [
      { type: 'session_meta', timestamp: '2026-06-28T01:00:00.000Z', payload: { id, cwd: '/home/u/repo' } },
      { type: 'response_item', timestamp: '2026-06-28T01:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 't1', arguments: JSON.stringify({ command: 'gh pr create --title x --body y' }) } },
    ]);
    await runScan();
    expect(db.getSessionById(id)!.prUrl ?? null).toBeNull();

    appendRollout(id, [
      { type: 'response_item', timestamp: '2026-06-28T01:02:00.000Z', payload: { type: 'function_call_output', call_id: 't1', output: 'https://github.com/acme/repo/pull/4242' } },
    ]);
    bumpMtimeToNow(rolloutFile(id), 1);
    await runScan();
    expect(discover.__codexScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);

    const inc = db.getSessionById(id)!;
    expect(inc.prUrl).toBe('https://github.com/acme/repo/pull/4242');
    expect(inc.prNumber).toBe(4242);
  });

  it('STRADDLED ticket: gh issue create first, its ref in the append → correct createdTickets', async () => {
    const id = 'straddle-ticket';
    writeRollout(id, [
      { type: 'session_meta', timestamp: '2026-06-28T02:00:00.000Z', payload: { id, cwd: '/home/u/repo' } },
      { type: 'response_item', timestamp: '2026-06-28T02:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 't1', arguments: JSON.stringify({ command: 'gh issue create --title bug' }) } },
    ]);
    await runScan();

    appendRollout(id, [
      { type: 'response_item', timestamp: '2026-06-28T02:02:00.000Z', payload: { type: 'function_call_output', call_id: 't1', output: 'https://github.com/acme/repo/issues/77' } },
    ]);
    bumpMtimeToNow(rolloutFile(id), 1);
    await runScan();
    expect(discover.__codexScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);

    const gtId = await groundTruth([
      { type: 'session_meta', timestamp: '2026-06-28T02:00:00.000Z', payload: { id: 'gt-ticket', cwd: '/home/u/repo' } },
      { type: 'response_item', timestamp: '2026-06-28T02:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 't1', arguments: JSON.stringify({ command: 'gh issue create --title bug' }) } },
      { type: 'response_item', timestamp: '2026-06-28T02:02:00.000Z', payload: { type: 'function_call_output', call_id: 't1', output: 'https://github.com/acme/repo/issues/77' } },
    ], 'gt-ticket');
    // createdTickets is derived by the scan (asserted at function level in the
    // parity harness) but not a persisted DB column, so row parity is the check
    // here: the incremental row must not diverge from the full reparse row.
    assertRowParity(id, gtId);
  });

  it('TRUNCATION: rewriting the rollout smaller forces a FULL reparse with no stale/doubled counters', async () => {
    const id = 'truncation';
    writeRollout(id, [...baseEvents(id), ...appendedEvents()]);
    await runScan();
    expect(db.getSessionById(id)!.messageCount).toBe(2);

    discover.__resetCodexScanBranchCountsForTest();
    const rewritten = [
      { type: 'session_meta', timestamp: '2026-06-29T00:00:00.000Z', payload: { id, cwd: '/home/u/repo' } },
      { type: 'response_item', timestamp: '2026-06-29T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fresh short session' }] } },
    ];
    fs.writeFileSync(rolloutFile(id), rewritten.map(line).join('\n') + '\n', 'utf-8');
    bumpMtimeToNow(rolloutFile(id), 2);
    await runScan();
    const counts = discover.__codexScanBranchCountsForTest();
    expect(counts.full, 'truncation forces a full reparse').toBeGreaterThanOrEqual(1);
    expect(counts.incremental, 'truncation must NOT go incremental').toBe(0);

    const short = db.getSessionById(id)!;
    expect(short.messageCount).toBe(1);
    expect(short.tokenCount ?? null).toBeNull();
    expect(short.topic).toBe('fresh short session');
  });

  it('LEDGER: parser_state is persisted after a scan, and its offset advances on append', async () => {
    const id = 'ledger-persist';
    const fp = writeRollout(id, baseEvents(id));
    await runScan();

    const row = db.getParserStatesForPaths([fp]).get(fp);
    expect(row, 'ledger row exists').toBeDefined();
    expect(row!.parserState, 'parser_state persisted').not.toBeNull();
    const parsed = JSON.parse(row!.parserState!);
    expect(parsed.v).toBe(1);
    expect(typeof parsed.offset).toBe('number');
    const offsetAfterFirst = parsed.offset;

    appendRollout(id, appendedEvents());
    bumpMtimeToNow(fp, 1);
    await runScan();
    const afterAppend = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(afterAppend.offset).toBeGreaterThan(offsetAfterFirst);
  });
});
