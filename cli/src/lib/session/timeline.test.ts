import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeContent, parseCodexItemsContent } from './parse.js';
import {
  classifyCommandVerb,
  compactTimelineState,
  emptyTimelineState,
  foldTimeline,
  projectSessionFiles,
  projectTimeline,
  unavailableTimeline,
  verbClassForEvent,
  TIMELINE_KEEP_STEPS,
} from './timeline.js';
import type { SessionEvent } from './types.js';

const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata');
/** A real Claude session (c9d700d5, 2026-09-06): 420 records, redacted and value-capped. */
const CLAUDE_FIXTURE = path.join(TESTDATA, 'timeline-claude.jsonl');
/** A real Codex rollout's `event_msg`/`item_completed` stream (2026-09-05), redacted. */
const CODEX_FIXTURE = path.join(TESTDATA, 'timeline-codex-items.jsonl');

const AT = (seconds: number): string => new Date(Date.UTC(2026, 8, 6, 0, 0, seconds)).toISOString();

function narration(seconds: number, content: string): SessionEvent {
  return { type: 'message', agent: 'claude', timestamp: AT(seconds), role: 'assistant', content };
}
function bash(seconds: number, command: string, callId: string, label?: string): SessionEvent {
  return {
    type: 'tool_use', agent: 'claude', timestamp: AT(seconds), tool: 'Bash', callId,
    args: { command }, command, ...(label ? { label } : {}),
  };
}
function ok(seconds: number, callId: string): SessionEvent {
  return { type: 'tool_result', agent: 'claude', timestamp: AT(seconds), callId, success: true, outcome: 'ok' };
}
function failed(seconds: number, callId: string, exitCode = 2): SessionEvent {
  return { type: 'error', agent: 'claude', timestamp: AT(seconds), callId, outcome: 'error', exitCode };
}
function denied(seconds: number, callId: string): SessionEvent {
  return { type: 'error', agent: 'claude', timestamp: AT(seconds), callId, outcome: 'error', blocked: true };
}

describe('foldTimeline — the fold rules (PHNX-3939)', () => {
  it('opens a step on narration and attaches the tools that follow it', () => {
    const state = foldTimeline([
      narration(0, 'Checking the guard patterns. Then I will rename the branch.'),
      bash(1, 'sed -n 1,80p scripts/guard.ts', 'a'),
      ok(2, 'a'),
      bash(3, 'git worktree add -b fix ../wt', 'b'),
      ok(4, 'b'),
    ]);
    expect(state.steps).toHaveLength(1);
    const [step] = state.steps;
    expect(step.source).toBe('narration');
    // The headline is the first SENTENCE of the narration, not the whole block.
    expect(step.text).toBe('Checking the guard patterns.');
    expect(step.tools).toBe(2);
    expect(step.mix).toEqual({ read: 1, git: 1 });
    expect(step.marks).toEqual(['worktree created']);
    expect(step.endedAt).toBe(AT(3));
  });

  it('counts a denied call as blocked and a non-zero exit as failed', () => {
    const state = foldTimeline([
      narration(0, 'Trying two commands.'),
      bash(1, 'git switch -c feature', 'a'), denied(2, 'a'),
      bash(3, 'bun run build', 'b'), failed(4, 'b'),
    ]);
    expect(state.steps[0]).toMatchObject({ tools: 2, blocked: 1, failed: 1 });
  });

  it('does not count a search that exits 1 with no match as a failure', () => {
    const state = foldTimeline([
      narration(0, 'Searching for the symbol.'),
      bash(1, 'rg TODO src', 'a'),
      { type: 'error', agent: 'claude', timestamp: AT(2), callId: 'a', outcome: 'error', exitCode: 1, command: 'rg TODO src' },
    ]);
    expect(state.steps[0]).toMatchObject({ tools: 1, failed: 0 });
  });

  it('resolves a result onto the step that OWNED the call, not the open one', () => {
    const state = foldTimeline([
      narration(0, 'First beat.'), bash(1, 'bun run build', 'a'),
      narration(2, 'Second beat.'), bash(3, 'ls', 'b'), ok(4, 'b'),
      failed(5, 'a'),
    ]);
    expect(state.steps[0].failed).toBe(1);
    expect(state.steps[1].failed).toBe(0);
  });

  it('merges narration split across two blocks in the same breath', () => {
    const state = foldTimeline([
      narration(0, 'Reading the manifest.'),
      narration(1, 'Then mapping the CI targets.'),
      bash(2, 'cat manifest.json', 'a'),
    ]);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].text).toBe('Reading the manifest.');
    expect(state.steps[0].tools).toBe(1);
  });

  it('does NOT merge two narration beats separated by real work', () => {
    const state = foldTimeline([
      narration(0, 'Reading the manifest.'), bash(1, 'cat manifest.json', 'a'),
      narration(2, 'Now mapping the CI targets.'),
    ]);
    expect(state.steps).toHaveLength(2);
  });

  it('lets a thinking block open a step only when nothing is open or the open step is a wall of calls', () => {
    const thinking = (seconds: number, content: string): SessionEvent =>
      ({ type: 'thinking', agent: 'claude', timestamp: AT(seconds), content });

    // Nothing open → the thinking block is the beat.
    const opening = foldTimeline([thinking(0, 'I need to check the credential path first.')]);
    expect(opening.steps).toHaveLength(1);
    expect(opening.steps[0].source).toBe('thinking');

    // A young open step keeps the thinking block folded in.
    const quiet = foldTimeline([
      narration(0, 'Doing the thing.'), bash(1, 'ls', 'a'),
      thinking(2, 'That listing tells me the layout is flat.'),
    ]);
    expect(quiet.steps).toHaveLength(1);

    // Eight calls deep, the thinking block breaks the wall.
    const busy = foldTimeline([
      narration(0, 'Doing the thing.'),
      ...Array.from({ length: 8 }, (_, i) => bash(1 + i, 'ls', `c${i}`)),
      thinking(20, 'That is enough listing; now I can write the file.'),
    ]);
    expect(busy.steps).toHaveLength(2);
    expect(busy.steps[1].source).toBe('thinking');
  });

  it('ignores a signature-only thinking block', () => {
    const state = foldTimeline([{ type: 'thinking', agent: 'claude', timestamp: AT(0), content: 'ok' }]);
    expect(state.steps).toHaveLength(0);
  });

  it('creates a derived step when tools arrive with nothing said, headlined from the mix', () => {
    const state = foldTimeline([bash(0, 'bun run build', 'a'), bash(1, 'ls src', 'b')]);
    expect(state.steps[0].source).toBe('derived');
    const projected = projectTimeline(state, undefined);
    expect(projected.steps[0].text).toBe('Ran 1 command, read 1 file');
  });

  it('makes a genuine user turn its own step and closes the agent step', () => {
    const state = foldTimeline([
      narration(0, 'Working.'),
      { type: 'message', agent: 'claude', timestamp: AT(1), role: 'user', content: 'Stop and show me the plan first.' },
      bash(2, 'ls', 'a'),
    ]);
    expect(state.steps.map((s) => s.source)).toEqual(['narration', 'user', 'derived']);
    expect(state.steps[1].text).toBe('Stop and show me the plan first.');
    expect(state.turns).toBe(1);
    expect(state.request?.headline).toBe('Stop and show me the plan first.');
  });

  it('records an interruption as a user step', () => {
    const state = foldTimeline([
      narration(0, 'Working.'),
      { type: 'message', agent: 'claude', timestamp: AT(1), role: 'user', content: '[Request interrupted by user]' },
    ]);
    expect(state.steps[1]).toMatchObject({ source: 'user', text: 'Request interrupted by user' });
  });

  it('keeps only the LATEST genuine turn as the request, with a turn count', () => {
    const state = foldTimeline([
      { type: 'message', agent: 'claude', timestamp: AT(0), role: 'user', content: 'Build the parser.' },
      narration(1, 'On it.'),
      { type: 'message', agent: 'claude', timestamp: AT(2), role: 'user', content: 'Actually, revert that.' },
    ]);
    expect(state.request?.headline).toBe('Actually, revert that.');
    expect(state.firstRequest?.headline).toBe('Build the parser.');
    expect(state.request?.turns).toBe(2);
  });

  it('marks a compaction on the open step', () => {
    const state = foldTimeline([
      narration(0, 'Working.'),
      { type: 'hook', agent: 'codex', timestamp: AT(1), hookName: 'ContextCompaction', content: 'context compacted' },
    ]);
    expect(state.steps[0].marks).toEqual(['context compacted']);
  });
});

describe('verb classification', () => {
  it('takes the harness classification when it has one', () => {
    expect(verbClassForEvent({ type: 'tool_use', agent: 'codex', timestamp: AT(0), tool: 'Bash', verbClass: 'read', command: 'bun test' })).toBe('read');
  });

  it('derives the most consequential class across a compound command', () => {
    expect(classifyCommandVerb('cd repo && bun run test')).toBe('test');
    expect(classifyCommandVerb('git -C /repo commit -m "fix"')).toBe('git');
    expect(classifyCommandVerb('agents browser screenshot -o out.png')).toBe('browser');
    expect(classifyCommandVerb('agents run claude --interactive')).toBe('agent');
    expect(classifyCommandVerb('sed -n 1,40p file.ts')).toBe('read');
    expect(classifyCommandVerb('cat a.txt > b.txt')).toBe('edit');
    expect(classifyCommandVerb('rm -rf build')).toBe('edit');
    expect(classifyCommandVerb('docker build .')).toBe('run');
  });

  it('does not read a discarded stderr redirect as a write', () => {
    expect(classifyCommandVerb('grep -n foo src 2>/dev/null')).toBe('read');
  });

  it('falls back to the tool name, then to other', () => {
    expect(verbClassForEvent({ type: 'tool_use', agent: 'claude', timestamp: AT(0), tool: 'Read' })).toBe('read');
    expect(verbClassForEvent({ type: 'tool_use', agent: 'claude', timestamp: AT(0), tool: 'MysteryTool' })).toBe('other');
  });
});

describe('projectTimeline — the bound that rides the row', () => {
  it('keeps the last 8 steps and folds everything older into a counter', () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 12; i++) {
      events.push(narration(i * 10, `Beat number ${i} of the run.`));
      events.push(bash(i * 10 + 1, 'bun run build', `c${i}`));
      events.push(failed(i * 10 + 2, `c${i}`));
    }
    const projected = projectTimeline(foldTimeline(events), undefined);
    expect(projected.steps).toHaveLength(TIMELINE_KEEP_STEPS);
    expect(projected.earlier).toEqual({ steps: 4, tools: 4, failed: 4 });
    // Totals span the WHOLE session, not just the tail.
    expect(projected.tools).toBe(12);
    expect(projected.failed).toBe(12);
    expect(projected.state).toBe('ready');
  });

  it('marks the newest step live with the running tool label only while working', () => {
    const events = [narration(0, 'Reading the plan.'), bash(1, 'cat plan.md', 'a', 'Read the artifact layout test body')];
    expect(projectTimeline(foldTimeline(events), 'working').steps[0]).toMatchObject({
      live: true, now: 'Read the artifact layout test body',
    });
    expect(projectTimeline(foldTimeline(events), 'idle').steps[0].live).toBeUndefined();
  });

  it('reports an event cap honestly as partial rather than as a short timeline', () => {
    const events = [narration(0, 'One.'), narration(10, 'Two.'), narration(20, 'Three.')];
    const projected = projectTimeline(foldTimeline(events, undefined, { maxEvents: 2 }), undefined);
    expect(projected.state).toBe('partial');
    expect(projected.reason).toBeTruthy();
  });

  it('states unavailability instead of returning an empty ready timeline', () => {
    const timeline = unavailableTimeline('OpenClaw writes no parseable transcript');
    expect(timeline).toMatchObject({ state: 'unavailable', steps: [], tools: 0 });
    expect(timeline.reason).toContain('OpenClaw');
  });
});

describe('projectSessionFiles', () => {
  it('reads the harness file ledger when there is one', () => {
    const state = foldTimeline([
      narration(0, 'Writing the plan.'),
      { type: 'file_change', agent: 'codex', timestamp: AT(1), changes: [
        { path: '/repo/plan.md', op: 'created' },
        { path: '/repo/src/index.ts', op: 'modified' },
      ] },
    ]);
    const files = projectSessionFiles(state);
    expect(files?.source).toBe('harness');
    expect(files?.total).toBe(2);
    expect(files?.changes.map((c) => c.op).sort()).toEqual(['created', 'modified']);
    expect(state.steps[0].marks).toEqual(['2 files changed']);
  });

  it('falls back to Edit/Write calls for a harness with no ledger', () => {
    const state = foldTimeline([
      narration(0, 'Editing.'),
      { type: 'tool_use', agent: 'claude', timestamp: AT(1), tool: 'Write', args: { file_path: '/repo/new.ts' }, path: '/repo/new.ts' },
      { type: 'tool_use', agent: 'claude', timestamp: AT(2), tool: 'Edit', args: { file_path: '/repo/new.ts' }, path: '/repo/new.ts' },
      { type: 'tool_use', agent: 'claude', timestamp: AT(3), tool: 'Edit', args: { file_path: '/repo/old.ts' }, path: '/repo/old.ts' },
    ]);
    const files = projectSessionFiles(state);
    expect(files?.source).toBe('tools');
    expect(files?.total).toBe(2);
    expect(files?.changes.find((c) => c.path === '/repo/new.ts')).toMatchObject({ op: 'created', edits: 2 });
    expect(files?.changes.find((c) => c.path === '/repo/old.ts')).toMatchObject({ op: 'modified', edits: 1 });
  });

  it('returns undefined when the session changed nothing', () => {
    expect(projectSessionFiles(foldTimeline([narration(0, 'Just reading.')]))).toBeUndefined();
  });
});

describe('the fold is resumable — appended bytes equal the whole file', () => {
  /** Fold one transcript in one pass. */
  function whole(file: string, kind: 'claude' | 'codex') {
    const text = fs.readFileSync(file, 'utf8');
    const events = kind === 'claude'
      ? parseClaudeContent(text, { includeInterrupts: true, includeFileHistory: true })
      : parseCodexItemsContent(text);
    return foldTimeline(events, undefined, { offset: Buffer.byteLength(text) });
  }

  /** Fold the same transcript in `chunks` successive appends, resuming each time. */
  function incremental(file: string, kind: 'claude' | 'codex', chunks: number) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const per = Math.ceil(lines.length / chunks);
    let state = emptyTimelineState();
    let offset = 0;
    for (let i = 0; i < lines.length; i += per) {
      const text = `${lines.slice(i, i + per).join('\n')}\n`;
      offset += Buffer.byteLength(text);
      const events = kind === 'claude'
        ? parseClaudeContent(text, { includeInterrupts: true, includeFileHistory: true })
        : parseCodexItemsContent(text);
      state = foldTimeline(events, state, { offset });
    }
    return state;
  }

  it.each([
    ['claude', CLAUDE_FIXTURE] as const,
    ['codex', CODEX_FIXTURE] as const,
  ])('%s: folding five appends equals folding the file once', (kind, file) => {
    const once = whole(file, kind);
    const appended = incremental(file, kind, 5);
    expect(appended.offset).toBe(once.offset);
    expect(appended.steps).toEqual(once.steps);
    expect(appended.turns).toBe(once.turns);
    expect(appended.request).toEqual(once.request);
    expect(appended.files).toEqual(once.files);
    expect(projectTimeline(appended, 'working')).toEqual(projectTimeline(once, 'working'));
  });

  it('folds the real Claude transcript into narration-anchored steps with real counts', () => {
    const state = whole(CLAUDE_FIXTURE, 'claude');
    expect(state.steps.length).toBeGreaterThan(20);
    // The session opened with `/continue <id>` and the fold reads it as the command it is.
    expect(state.steps[0]).toMatchObject({ source: 'user', text: '/continue 8231082e' });
    // Every headline is the agent's own words or the user's — never generated.
    expect(state.steps.some((s) => s.source === 'narration')).toBe(true);
    expect(state.steps.some((s) => s.marks?.includes('worktree created'))).toBe(true);
    const projected = projectTimeline(state, 'working');
    expect(projected.tools).toBeGreaterThan(100);
    expect(projected.blocked).toBeGreaterThan(0);
    expect(projected.steps).toHaveLength(TIMELINE_KEEP_STEPS);
  });

  it('folds the real Codex item stream using the harness classification and ledger', () => {
    const state = whole(CODEX_FIXTURE, 'codex');
    expect(state.steps.length).toBeGreaterThan(5);
    // Codex tags its narration `phase: commentary`; those are the headlines.
    expect(state.steps.some((s) => s.source === 'narration')).toBe(true);
    // `parsed_cmd.type` classified reads without the CLI re-deriving them.
    expect(state.steps.some((s) => (s.mix?.read ?? 0) > 0)).toBe(true);
    // FileChange gives exact per-path operations.
    const files = projectSessionFiles(state);
    expect(files?.source).toBe('harness');
    expect(files!.total).toBeGreaterThan(0);
  });
});

describe('compactTimelineState — bounded state, exact numbers', () => {
  it('rolls old steps into a counter without changing what the projection reports', () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 40; i++) {
      events.push(narration(i * 10, `Beat ${i} of the long run.`));
      events.push(bash(i * 10 + 1, 'bun run build', `c${i}`));
      events.push(failed(i * 10 + 2, `c${i}`));
    }
    const full = foldTimeline(events);
    const before = projectTimeline(full, undefined);
    const compacted = compactTimelineState(foldTimeline(events), 10, 10);
    const after = projectTimeline(compacted, undefined);
    expect(compacted.steps).toHaveLength(10);
    expect(after.steps).toEqual(before.steps);
    expect(after.earlier).toEqual(before.earlier);
    expect(after.tools).toBe(before.tools);
    expect(after.failed).toBe(before.failed);
  });

  it('keeps folding correctly after a compaction', () => {
    const first = compactTimelineState(foldTimeline([
      narration(0, 'One.'), bash(1, 'ls', 'a'),
      narration(2, 'Two.'), bash(3, 'ls', 'b'),
      narration(4, 'Three.'), bash(5, 'ls', 'c'),
    ]), 1, 10);
    const resumed = foldTimeline([narration(6, 'Four.'), bash(7, 'ls', 'd')], first);
    const projected = projectTimeline(resumed, undefined);
    expect(projected.tools).toBe(4);
    expect(projected.earlier.tools).toBe(2);
  });
});
