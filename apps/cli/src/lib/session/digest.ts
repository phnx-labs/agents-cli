/**
 * Catch-up digest extractors.
 *
 * Pure functions that turn a session's events into the signals a developer needs
 * to reload a task fast when switching between many agents: which files changed
 * and how (created / modified / deleted), which tools dominated the work, and the
 * last test/build result. Consumed by the single-session view and the picker
 * preview. No I/O — fully unit-testable.
 */

import type { SessionEvent } from './types.js';

export type FileOp = 'created' | 'modified' | 'deleted';
export interface FileChange {
  path: string;
  op: FileOp;
}

// Tool vocab mirrors parse.ts / render.ts so classification matches what those
// modules already recognize across Claude/Codex/others.
const READ_TOOLS = new Set(['Read', 'read_file', 'view_file', 'cat_file', 'get_file']);
const WRITE_TOOLS = new Set(['Write', 'write_file', 'create_file']);
const EDIT_TOOLS = new Set(['Edit', 'edit_file', 'replace', 'patch', 'MultiEdit', 'apply_patch']);

/** Extract file paths deleted by a shell command (rm / git rm / unlink). Conservative. */
export function extractDeletedPaths(command: string): string[] {
  const out: string[] = [];
  // Split on && ; | to inspect each simple command separately.
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    const m = seg.trim().match(/^(?:sudo\s+)?(?:git\s+rm|rm|unlink)\s+(.+)$/);
    if (!m) continue;
    for (const tok of m[1].split(/\s+/)) {
      if (tok.startsWith('-')) continue;          // flags (-r, -f, --force)
      if (/[*?{}]/.test(tok)) continue;           // globs — too imprecise to attribute
      out.push(tok.replace(/^['"]|['"]$/g, ''));  // unquote
    }
  }
  return out;
}

/**
 * Classify every touched file as created / modified / deleted from the event
 * stream. Heuristics: a Write to a path never previously Read and not seen
 * before is a *creation*; an Edit (or a Write to a known/read path) is a
 * *modification*; a path in an `rm`/`git rm` command is a *deletion* (and wins
 * over create/modify — a created-then-deleted file nets to gone). Plan files
 * (`.claude/plans/*.md`) are excluded; they're surfaced by detectPlan.
 */
export function classifyFileChanges(events: SessionEvent[]): FileChange[] {
  const readBefore = new Set<string>();
  const created = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const seen = new Set<string>();

  for (const e of events) {
    if (e.type !== 'tool_use' || e._local) continue;
    if (e.command) for (const d of extractDeletedPaths(e.command)) deleted.add(d);

    const tool = e.tool || '';
    const args = e.args || {};
    const p = e.path || args.file_path || args.path || '';
    if (!p) continue;
    if (p.includes('.claude/plans/') && p.endsWith('.md')) continue;

    if (READ_TOOLS.has(tool)) {
      readBefore.add(p);
    } else if (WRITE_TOOLS.has(tool)) {
      if (!seen.has(p) && !readBefore.has(p)) created.add(p);
      else modified.add(p);
      seen.add(p);
      deleted.delete(p); // a write after a delete recreates the file
    } else if (EDIT_TOOLS.has(tool)) {
      modified.add(p);
      seen.add(p);
      deleted.delete(p);
    }
  }

  const out: FileChange[] = [];
  for (const p of created) if (!deleted.has(p)) out.push({ path: p, op: 'created' });
  for (const p of modified) if (!created.has(p) && !deleted.has(p)) out.push({ path: p, op: 'modified' });
  for (const p of deleted) out.push({ path: p, op: 'deleted' });
  return out;
}

/** Net change summary: counts per op. */
export function changeCounts(changes: FileChange[]): { created: number; modified: number; deleted: number } {
  const c = { created: 0, modified: 0, deleted: 0 };
  for (const ch of changes) c[ch.op]++;
  return c;
}

/** Tool histogram sorted highest-first, capped to `top` entries. */
export function toolHistogram(toolCounts: Record<string, number>, top = 8): Array<{ tool: string; count: number }> {
  return Object.entries(toolCounts)
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, top);
}

export interface TestResult {
  runner: string;
  passed?: number;
  failed?: number;
  /** True when we could parse a pass/fail verdict. */
  ok: boolean;
  ts: number;
}

/** Recognized test/build runners → the label we show. */
const TEST_RUNNERS: Array<{ re: RegExp; label: string }> = [
  { re: /\b((?:bun|npm|yarn|pnpm)\s+(?:run\s+)?test|vitest|jest)\b/, label: 'tests' },
  { re: /\bpytest\b/, label: 'pytest' },
  { re: /\bgo\s+test\b/, label: 'go test' },
  { re: /\bcargo\s+test\b/, label: 'cargo test' },
  { re: /\b(tsc|tsc\s+--noEmit)\b/, label: 'tsc' },
];

/** Parse pass/fail counts from common runner output. */
function parseTestOutput(runner: string, output: string): { passed?: number; failed?: number; ok: boolean } {
  // vitest/jest/bun: "N passed", "N failed"; pytest: "N passed, N failed".
  // Take the LAST occurrence — runners print a per-file line first, then the
  // authoritative aggregate ("Tests 4 failed | 294 passed") at the end.
  const lastNum = (re: RegExp): number | undefined => {
    let m: RegExpExecArray | null;
    let val: number | undefined;
    const g = new RegExp(re.source, 'gi');
    while ((m = g.exec(output)) !== null) val = +m[1];
    return val;
  };
  const passed = lastNum(/(\d+)\s+pass(?:ed)?/);
  const failed = lastNum(/(\d+)\s+fail(?:ed|ures?)?/);
  if (passed !== undefined || failed !== undefined) {
    return { passed, failed, ok: true };
  }
  // tsc: no news is good news; "error TSxxxx" means failure.
  if (runner === 'tsc') {
    const errs = output.match(/error\s+TS\d+/gi);
    return { failed: errs ? errs.length : 0, ok: true };
  }
  // go test: no pass/fail counts — uses `--- PASS/FAIL:` lines and an ok/FAIL
  // summary. Count the per-test markers; fall back to the summary verdict.
  if (runner === 'go test') {
    const passCount = (output.match(/---\s+PASS/gi) || []).length;
    const failCount = (output.match(/---\s+FAIL/gi) || []).length;
    const sawFail = failCount > 0 || /(^|\s)FAIL($|\s)/.test(output);
    const sawOk = /(^|\s)(ok|PASS)($|\s)/.test(output);
    if (sawFail || sawOk) {
      return { passed: passCount || undefined, failed: sawFail ? failCount || 1 : 0, ok: true };
    }
  }
  return { ok: false };
}

/**
 * The most recent test/build run and its verdict. Correlates a runner command
 * (tool_use) with the next tool_result's output. Returns undefined if none ran.
 */
export function detectTestResult(events: SessionEvent[]): TestResult | undefined {
  let pending: { runner: string; ts: number } | null = null;
  let last: TestResult | undefined;

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime() || 0;
    if (e.type === 'tool_use' && e.command) {
      const hit = TEST_RUNNERS.find(r => r.re.test(e.command!));
      pending = hit ? { runner: hit.label, ts } : pending;
    } else if (e.type === 'tool_result' && pending) {
      const parsed = parseTestOutput(pending.runner, e.output || '');
      last = { runner: pending.runner, ts: pending.ts, ...parsed };
      pending = null;
    } else if (e.type === 'error' && pending) {
      last = { runner: pending.runner, ts: pending.ts, ok: true, failed: 1 };
      pending = null;
    }
  }
  return last;
}
