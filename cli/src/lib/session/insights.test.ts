/**
 * Facet extraction and rollup. Pure functions over real `SessionEvent[]` shapes — the
 * same objects `parseSession` emits, built here by hand so each assertion pins one
 * behaviour rather than a whole transcript's worth of coincidences.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  computeInsightFacets,
  detectOverlap,
  percentile,
  bucketGaps,
  topEntries,
  mergeFacets,
  newFacetAccumulator,
  buildInsightActions,
  type SessionSpan,
} from './insights.js';
import type { SessionEvent } from './types.js';

const T0 = Date.parse('2026-07-01T12:00:00.000Z');
/** An ISO timestamp `seconds` after the fixture epoch. */
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function userMsg(seconds: number, content: string, slashCommand?: string): SessionEvent {
  return { type: 'message', agent: 'claude', timestamp: at(seconds), role: 'user', content, ...(slashCommand ? { slashCommand } : {}) };
}
function asstMsg(seconds: number, content = 'ok'): SessionEvent {
  return { type: 'message', agent: 'claude', timestamp: at(seconds), role: 'assistant', content };
}
function tool(seconds: number, name: string, args: Record<string, unknown>, command?: string): SessionEvent {
  return {
    type: 'tool_use', agent: 'claude', timestamp: at(seconds), tool: name, args,
    path: (args.file_path as string) ?? undefined,
    ...(command ? { command } : {}),
  };
}

describe('computeInsightFacets', () => {
  it('counts interrupt events, which the message stream deliberately excludes', () => {
    // parse.ts emits `interrupt` rather than a user message, so this is the only
    // place the signal survives. Regression guard for that contract.
    const f = computeInsightFacets([
      userMsg(0, 'do the thing'),
      { type: 'interrupt', agent: 'claude', timestamp: at(5), content: '[Request interrupted by user]' },
      userMsg(10, 'actually do this instead'),
      { type: 'interrupt', agent: 'claude', timestamp: at(20), content: '[Request interrupted by user for tool use]' },
    ], 0);
    expect(f.interruptions).toBe(2);
    // …and they must not inflate the user turn count.
    expect(f.userTurns).toBe(2);
  });

  it('counts git commits and pushes, including chained commands', () => {
    const f = computeInsightFacets([
      tool(0, 'Bash', {}, 'git add -A && git commit -m "one"'),
      tool(1, 'Bash', {}, 'git commit -m "two" && git push origin main'),
      tool(2, 'Bash', {}, 'git -C /repo push'),
      tool(3, 'Bash', {}, 'echo "git commit is not run here"'.replace('git commit', 'git-commit')),
    ], 0);
    expect(f.gitCommits).toBe(2);
    expect(f.gitPushes).toBe(2);
  });

  it('buckets shell commands by binary + subcommand, not under the harness tool name', () => {
    const f = computeInsightFacets([
      tool(0, 'Bash', {}, 'git commit -m "x"'),
      tool(1, 'Bash', {}, 'git commit -m "y"'),
      tool(2, 'Bash', {}, 'gh pr create --fill'),
      tool(3, 'Bash', {}, 'find . -name "*.ts"'),
      // A path executable and an ssh wrapper resolve by basename / wrapped target.
      tool(4, 'Bash', {}, '/usr/bin/git status'),
      tool(5, 'Bash', {}, 'ssh box git pull'),
      // Cross-harness: codex sets `command` on exec_command, not a Claude `Bash`.
      tool(6, 'exec_command', {}, 'agents sessions --active'),
    ], 0);
    expect(f.bashCommands['git commit']).toBe(2);
    // Two-level tools bucket by their first subcommand token (gh/agents/git).
    expect(f.bashCommands['gh pr']).toBe(1);
    expect(f.bashCommands['find']).toBe(1);
    expect(f.bashCommands['git status']).toBe(1);
    expect(f.bashCommands['ssh→git pull']).toBe(1);
    // The exec_command's command string still buckets — not lost as a non-Bash tool.
    expect(f.bashCommands['agents sessions']).toBe(1);
  });

  it('attributes a failed tool call to the binary of that tool’s last command', () => {
    const f = computeInsightFacets([
      tool(0, 'Bash', {}, 'find .agents -iname "*eval*"'),
      { type: 'error', agent: 'claude', timestamp: at(1), tool: 'Bash', content: 'Command failed' },
      tool(2, 'Bash', {}, 'gh pr list'),
      { type: 'error', agent: 'claude', timestamp: at(3), tool: 'Bash', content: 'rate limit exceeded' },
    ], 0);
    expect(f.bashCommandFailures['find']).toBe(1);
    expect(f.bashCommandFailures['gh pr']).toBe(1);
  });

  it('derives line deltas from Edit and Write arguments', () => {
    const f = computeInsightFacets([
      tool(0, 'Edit', { file_path: '/r/a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree\nfour' }),
      tool(1, 'Write', { file_path: '/r/b.ts', content: 'a\nb\nc' }),
    ], 0);
    expect(f.linesTouchedBefore).toBe(2);
    expect(f.linesTouchedAfter).toBe(4 + 3);
  });

  it('sums every edit of a MultiEdit', () => {
    const f = computeInsightFacets([
      tool(0, 'MultiEdit', {
        file_path: '/r/a.ts',
        edits: [
          { old_string: 'x', new_string: 'x\ny' },
          { old_string: 'p\nq', new_string: 'p' },
        ],
      }),
    ], 0);
    expect(f.linesTouchedAfter).toBe(2 + 1);
    expect(f.linesTouchedBefore).toBe(1 + 2);
  });

  it('attributes languages by file extension', () => {
    const f = computeInsightFacets([
      tool(0, 'Write', { file_path: '/r/a.ts', content: 'x' }),
      tool(1, 'Write', { file_path: '/r/b.tsx', content: 'x' }),
      tool(2, 'Write', { file_path: '/r/c.py', content: 'x' }),
      tool(3, 'Write', { file_path: '/r/d.unknownext', content: 'x' }),
    ], 0);
    expect(f.languages).toEqual({ TypeScript: 2, Python: 1 });
  });

  it('buckets tool errors by their message, falling back to Other', () => {
    const f = computeInsightFacets([
      { type: 'error', agent: 'claude', timestamp: at(0), content: 'String to replace not found in file' },
      { type: 'error', agent: 'claude', timestamp: at(1), content: 'File has been modified since read' },
      { type: 'error', agent: 'claude', timestamp: at(2), content: 'Command failed with exit code 1' },
      { type: 'error', agent: 'claude', timestamp: at(3), content: 'something nobody anticipated' },
    ], 0);
    expect(f.errorCategories).toEqual({
      'Edit Failed': 1, 'File Changed': 1, 'Command Failed': 1, Other: 1,
    });
    expect(f.errorCount).toBe(4);
  });

  it('measures the gap between the assistant going quiet and the user replying', () => {
    const f = computeInsightFacets([
      userMsg(0, 'go'),
      asstMsg(10),
      userMsg(70, 'next'),      // 60s
      asstMsg(80),
      userMsg(81, 'quick'),     // 1s — a fast reply is still a reply, and censoring
                                //      these inflated the reported p50 by 63%
      asstMsg(90),
      userMsg(90 + 7200, 'back tomorrow'), // 2h — over the ceiling, counted separately
    ], 0);
    expect(f.responseGaps).toEqual([60, 1]);
    expect(f.gapsOverCeiling).toBe(1);
    // 2h idle after assistant still counts as a silent stall (1h+ bucket).
    expect(f.frictionSignals['silent stall: 1h+']).toBe(1);
  });

  it('classifies agent silent stalls from timestamps (model idle until human resumes)', () => {
    // Assistant stops at t=10; user "continue" at t=10+600 (10m later) → 5-15m stall + resume nudge.
    // Assistant stops again; user arbitrary "ok next" after 20m → 15-60m stall, no resume nudge.
    // Sub-threshold 2m gap is normal turn-taking — not a silent stall.
    const f = computeInsightFacets([
      userMsg(0, 'build it'),
      asstMsg(10, 'working…'),
      userMsg(10 + 600, 'continue'),
      asstMsg(700, 'more work'),
      userMsg(700 + 1200, 'ok next file'),
      asstMsg(2000, 'done for now'),
      userMsg(2000 + 120, 'small follow-up'),
    ], 0);
    expect(f.frictionSignals['silent stall: 5-15m']).toBe(1);
    expect(f.frictionSignals['silent stall: 15-60m']).toBe(1);
    expect(f.frictionSignals['silent stall: 1h+']).toBeUndefined();
    expect(f.correctionSignals['resume after silent stall']).toBe(1);
    expect(f.correctionSignals['continue / keep going']).toBe(1);
    // 2m gap stays in reply-latency sample, not silent-stall friction.
    expect(f.responseGaps).toContain(120);
  });

  it('attributes silent stalls to the model that last spoke (laziness split)', () => {
    const f = computeInsightFacets([
      userMsg(0, 'go'),
      { type: 'usage', agent: 'claude', timestamp: at(5), model: 'claude-opus-4-8-20250514' } as SessionEvent,
      asstMsg(10, 'working'),
      userMsg(10 + 600, 'continue'),
      { type: 'usage', agent: 'claude', timestamp: at(700), model: 'claude-sonnet-4-20250514' } as SessionEvent,
      asstMsg(710, 'more'),
      userMsg(710 + 1200, 'ok'),
    ], 0);
    expect(f.silentStallsByModel['opus-4-8']).toBe(1);
    expect(f.silentStallsByModel['sonnet-4']).toBe(1);
  });

  it('emits a high-priority action for resume-after-silent-stall patterns', () => {
    const facets = computeInsightFacets([
      userMsg(0, 'ship it'),
      asstMsg(5),
      userMsg(5 + 900, 'keep going'),
    ], 0);
    const actions = buildInsightActions([{ id: 'bbbbbbbb-stall-sess', facets }]);
    expect(actions.some((a) =>
      a.action.includes('Never stop mid-task') && a.evidenceCount >= 1,
    )).toBe(true);
    expect(actions.some((a) =>
      a.action.includes('Stop ending turns while work remains') ||
      a.action.includes('Long idle after the assistant'),
    )).toBe(true);
  });

  it('ignores synthetic user messages so stop-hook feedback does not end a silent stall', () => {
    // Assistant at t=0; synthetic meta at t=600 (would look like a 10m gap); real
    // "continue" at t=1200 (20m from assistant). Stall must be measured to the real
    // human message, not the injected row.
    const f = computeInsightFacets([
      userMsg(0, 'build'),
      asstMsg(1, 'working'),
      {
        type: 'message', agent: 'claude', timestamp: at(600), role: 'user',
        content: 'Stop hook feedback: open PR still…', _synthetic: true,
      } as SessionEvent,
      userMsg(1200, 'continue'),
    ], 0);
    expect(f.frictionSignals['silent stall: 15-60m']).toBe(1);
    expect(f.frictionSignals['silent stall: 5-15m']).toBeUndefined();
    expect(f.correctionSignals['resume after silent stall']).toBe(1);
  });

  it('rejects a negative gap from clock skew rather than counting it', () => {
    // Removing the old 2s floor removed the implicit negative guard with it; a real
    // corpus contained a gap of -8.662s from out-of-order record timestamps.
    const f = computeInsightFacets([
      userMsg(0, 'go'),
      asstMsg(50),
      userMsg(40, 'arrived with an earlier stamp than the reply it follows'),
    ], 0);
    expect(f.responseGaps).toEqual([]);
    expect(f.gapsOverCeiling).toBe(0);
  });

  it('bins user messages by local hour', () => {
    // UTC 12:00 with a -60min offset (UTC+1) is 13:00 local.
    const f = computeInsightFacets([userMsg(0, 'a'), userMsg(3600, 'b')], -60);
    expect(f.messageHours[13]).toBe(1);
    expect(f.messageHours[14]).toBe(1);
    expect(f.messageHours.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('records models and slash commands', () => {
    const f = computeInsightFacets([
      { type: 'usage', agent: 'claude', timestamp: at(0), model: 'claude-opus-5', outputTokens: 10 },
      { type: 'usage', agent: 'claude', timestamp: at(1), model: 'claude-opus-5', outputTokens: 5 },
      { type: 'usage', agent: 'claude', timestamp: at(2), model: 'claude-sonnet-5', outputTokens: 1 },
      userMsg(3, '/commit', 'commit'),
    ], 0);
    // Normalized with shortenModel so the label matches every other renderer.
    expect(f.models).toEqual({ 'opus-5': 2, 'sonnet-5': 1 });
    expect(f.slashCommands).toEqual({ commit: 1 });
  });

  it('ignores local tool calls, which are not model actions', () => {
    const local: SessionEvent = { ...tool(0, 'Bash', {}, 'git commit -m x'), _local: true };
    const f = computeInsightFacets([local], 0);
    expect(f.gitCommits).toBe(0);
    expect(f.toolCount).toBe(0);
  });
});

describe('cross-harness tool vocabulary', () => {
  it('counts line deltas for a non-Claude write tool', () => {
    // Keying on the literals 'Edit'|'Write' meant codex reported 5,197 tool calls and
    // exactly zero lines touched, rendered under the same heading as a real number.
    const f = computeInsightFacets([tool(0, 'write_file', { file_path: '/r/a.py', content: 'a\nb' })], 0);
    expect(f.linesTouchedAfter).toBe(2);
    expect(f.editingToolCalls).toBe(1);
  });

  it('reports zero editing calls when the harness vocabulary is unknown', () => {
    // The signal the renderer uses to print "not measurable" instead of a false 0.
    const f = computeInsightFacets([tool(0, 'exec', { cmd: 'ls' })], 0);
    expect(f.editingToolCalls).toBe(0);
    expect(f.linesTouchedAfter).toBe(0);
  });
});

describe('lineCount via facets', () => {
  it('does not over-count newline-terminated content', () => {
    // "a\nb\n" is two lines. split('\n').length says three.
    const f = computeInsightFacets([tool(0, 'Write', { file_path: '/r/a.ts', content: 'a\nb\n' })], 0);
    expect(f.linesTouchedAfter).toBe(2);
  });
});

describe('detectOverlap', () => {
  const span = (id: string, accountKey: string, startS: number, endS: number): SessionSpan =>
    ({ id, accountKey, startMs: T0 + startS * 1000, endMs: T0 + endS * 1000 });

  it('finds concurrent sessions and flags the cross-account ones', () => {
    const r = detectOverlap([
      span('a', 'org-1', 0, 100),
      span('b', 'org-2', 50, 150),   // overlaps a, different account
      span('c', 'org-1', 200, 300),  // overlaps nothing
    ]);
    expect(r.overlappingPairs).toBe(1);
    expect(r.crossAccountPairs).toBe(1);
    expect(r.sessionsInvolved).toBe(2);
  });

  it('does not count same-account overlap as cross-account', () => {
    const r = detectOverlap([span('a', 'org-1', 0, 100), span('b', 'org-1', 10, 20)]);
    expect(r.overlappingPairs).toBe(1);
    expect(r.crossAccountPairs).toBe(0);
  });

  it('treats touching spans as not overlapping', () => {
    const r = detectOverlap([span('a', 'org-1', 0, 100), span('b', 'org-2', 100, 200)]);
    expect(r.overlappingPairs).toBe(0);
  });

  it('drops zero-length and non-finite spans rather than counting them', () => {
    const r = detectOverlap([
      span('a', 'org-1', 0, 0),
      { id: 'b', accountKey: 'org-1', startMs: NaN, endMs: 10 },
      span('c', 'org-1', 0, 100),
    ]);
    expect(r.overlappingPairs).toBe(0);
    expect(r.sessionsInvolved).toBe(0);
  });
});

describe('percentile and bucketGaps', () => {
  it('returns 0 for an empty sample instead of NaN', () => {
    expect(percentile([], 50)).toBe(0);
    expect(bucketGaps([]).every((b) => b.count === 0)).toBe(true);
  });

  it('uses nearest-rank, so p50 of 1..4 is the second value', () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([4, 1, 3, 2], 100)).toBe(4);
  });

  it('places each gap in exactly one bucket', () => {
    const buckets = bucketGaps([5, 15, 45, 90, 200, 600, 5000]);
    expect(buckets.map((b) => b.count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(7);
  });
});

describe('mergeFacets', () => {
  it('folds two sessions into one total without losing a dimension', () => {
    const a = computeInsightFacets([
      tool(0, 'Write', { file_path: '/r/a.ts', content: 'x\ny' }),
      { type: 'interrupt', agent: 'claude', timestamp: at(1), content: '[Request interrupted' },
    ], 0);
    const b = computeInsightFacets([
      tool(0, 'Write', { file_path: '/r/b.py', content: 'z' }),
      tool(1, 'Bash', {}, 'git push'),
    ], 0);

    const total = newFacetAccumulator();
    mergeFacets(total, a);
    mergeFacets(total, b);

    expect(total.linesTouchedAfter).toBe(3);
    expect(total.interruptions).toBe(1);
    expect(total.gitPushes).toBe(1);
    expect(total.languages).toEqual({ TypeScript: 1, Python: 1 });
    expect(total.toolCounts).toEqual({ Write: 2, Bash: 1 });
    expect(total.messageHours).toHaveLength(24);
  });
});

describe('topEntries', () => {
  it('sorts by count then name, so output is stable across runs', () => {
    expect(topEntries({ b: 2, a: 2, c: 5 }, 3)).toEqual([
      { name: 'c', count: 5 },
      { name: 'a', count: 2 },
      { name: 'b', count: 2 },
    ]);
  });
});

describe('actions-forward analysis', () => {
  it('classifies corrections, AskUserQuestion stalls, failed loops, and repeatable recipes', () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.join(import.meta.dirname, 'testdata', 'insights-actions.json'), 'utf8',
    )) as SessionEvent[];
    const facets = computeInsightFacets(fixture, 0);

    expect(facets.correctionSignals).toMatchObject({
      'continue / keep going': 1,
      'Ask stall: release / ship / deploy': 1,
    });
    expect(facets.frictionSignals).toMatchObject({
      'CI red loop': 2,
      'failed tool loop: exec_command': 1,
    });
    expect(facets.automationSignals['PR babysitting']).toBe(1);
  });

  it('emits deterministic actions with bounded, redacted session identifiers', () => {
    const facets = computeInsightFacets([userMsg(0, 'did you merge?')], 0);
    const actions = buildInsightActions([{ id: 'aaaaaaaa-secret-tail', facets }]);
    expect(actions).toEqual([expect.objectContaining({
      category: 'automation',
      evidenceCount: 1,
      sampleSessionIds: ['aaaaaaaa'],
    })]);
  });
});
