import { describe, expect, it } from 'vitest';
import {
  countsFromIssuesResponse,
  fetchLinearProjectCounts,
  nextMilestone,
  type LinearIssuesResponse,
} from './linear-project-counts.js';

/** A recorded Linear `issues` response shape (state types only, trimmed). */
function response(types: (string | null | undefined)[]): LinearIssuesResponse {
  return {
    issues: {
      nodes: types.map((t) => (t === undefined ? {} : { state: t === null ? null : { type: t } })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

/** A paged response with an explicit cursor. */
function page(types: string[], hasNextPage: boolean, endCursor: string | null): LinearIssuesResponse {
  return {
    issues: {
      nodes: types.map((t) => ({ state: { type: t } })),
      pageInfo: { hasNextPage, endCursor },
    },
  };
}

/** Scripted page fetcher: serves `pages` in order, recording the cursors it was called with. */
function scriptedPages(pages: LinearIssuesResponse[]) {
  const calls: Array<string | undefined> = [];
  const fetchPage = async (_p: string, after: string | undefined) => {
    calls.push(after);
    return pages[calls.length - 1];
  };
  return { calls, fetchPage };
}

describe('countsFromIssuesResponse', () => {
  it('groups by state type: completed → done, started → inProgress, all → total', () => {
    const counts = countsFromIssuesResponse(
      response([
        'completed', 'completed', 'completed', // 3 done
        'started', 'started', // 2 in progress
        'unstarted', 'backlog', 'triage', 'canceled', // neither
      ]),
    );
    expect(counts).toEqual({ done: 3, total: 9, inProgress: 2 });
  });

  it('an issue with no state still counts toward total', () => {
    const counts = countsFromIssuesResponse(response([null, undefined, 'completed']));
    expect(counts).toEqual({ done: 1, total: 3, inProgress: 0 });
  });

  it('an empty / malformed response is zeros, never a throw', () => {
    expect(countsFromIssuesResponse({})).toEqual({ done: 0, total: 0, inProgress: 0 });
    expect(countsFromIssuesResponse({ issues: {} })).toEqual({ done: 0, total: 0, inProgress: 0 });
  });
});

describe('fetchLinearProjectCounts — pagination accumulator', () => {
  it('concatenates pages without overlap, handing the cursor across', async () => {
    const { calls, fetchPage } = scriptedPages([
      page(['completed', 'started'], true, 'cur-1'),
      page(['completed', 'backlog'], false, null),
    ]);
    const counts = await fetchLinearProjectCounts('proj-1', fetchPage);
    expect(calls).toEqual([undefined, 'cur-1']);
    expect(counts).toEqual({ done: 2, total: 4, inProgress: 1 });
  });

  it('terminates when hasNextPage is true but the cursor is null (no infinite loop)', async () => {
    const { calls, fetchPage } = scriptedPages([page(['completed'], true, null)]);
    const counts = await fetchLinearProjectCounts('proj-1', fetchPage);
    expect(calls).toHaveLength(1);
    expect(counts).toEqual({ done: 1, total: 1, inProgress: 0 });
  });

  it('hits the page cap and reports truncated instead of lying about the total', async () => {
    const endless = page(['completed'], true, 'cur');
    const { calls, fetchPage } = scriptedPages(Array.from({ length: 20 }, () => endless));
    const counts = await fetchLinearProjectCounts('proj-1', fetchPage);
    expect(calls).toHaveLength(10); // MAX_PAGES, no more
    expect(counts).toEqual({ done: 10, total: 10, inProgress: 0, truncated: true });
  });

  it('a failed page degrades the whole enrichment to undefined (card omits the line)', async () => {
    const fetchPage = async () => undefined;
    expect(await fetchLinearProjectCounts('proj-1', fetchPage)).toBeUndefined();
  });
});

/** An issue node as the query selects it: state plus a milestone id, if any. */
function issue(stateType: string, msId?: string) {
  return { state: { type: stateType }, ...(msId ? { projectMilestone: { id: msId } } : {}) };
}

const M1 = { id: 'm1', name: 'Beta cut', targetDate: '2026-08-21' };
const M2 = { id: 'm2', name: 'GA', targetDate: '2026-09-30' };

describe('nextMilestone', () => {
  it('picks the earliest-dated milestone that still has work', () => {
    expect(
      nextMilestone([M2, M1], [issue('completed', 'm2'), issue('started', 'm2'), issue('completed', 'm1'), issue('unstarted', 'm1')]),
    ).toEqual({ name: 'Beta cut', targetDate: '2026-08-21', done: 1, total: 2 });
  });

  it('surfaces a declared milestone with NO issues filed under it', () => {
    // The real case: the milestone exists on the project, nothing is assigned
    // to it yet. Deriving the list from issues made these invisible.
    expect(nextMilestone([M1], [issue('started'), issue('completed')])).toEqual({
      name: 'Beta cut',
      targetDate: '2026-08-21',
      done: 0,
      total: 0,
    });
  });

  it('skips a finished milestone — done is not "next"', () => {
    expect(nextMilestone([M1, M2], [issue('completed', 'm1'), issue('completed', 'm1'), issue('started', 'm2')])).toEqual({
      name: 'GA',
      targetDate: '2026-09-30',
      done: 0,
      total: 1,
    });
  });

  it('returns nothing when the project declares no milestones, or all are complete', () => {
    expect(nextMilestone([], [issue('started', 'm1')])).toBeUndefined();
    expect(nextMilestone([M1], [issue('completed', 'm1')])).toBeUndefined();
  });

  it('sorts undated milestones last but still surfaces one when nothing is dated', () => {
    const undated = { id: 'm3', name: 'Someday' };
    expect(nextMilestone([undated, M1], [])?.name).toBe('Beta cut');
    const only = nextMilestone([undated], []);
    expect(only).toEqual({ name: 'Someday', done: 0, total: 0 });
    expect(only?.targetDate).toBeUndefined();
  });

  it('ignores a malformed declared milestone rather than inventing one', () => {
    expect(nextMilestone([{ name: 'no id' }, { id: 'x', name: '' }], [])).toBeUndefined();
  });
});

describe('countsFromIssuesResponse — milestone', () => {
  it('carries the next milestone alongside the counts, and omits it when there is none', () => {
    const withMs = countsFromIssuesResponse({
      issues: { nodes: [issue('completed', 'm1'), issue('started', 'm1')] },
      project: { projectMilestones: { nodes: [M1] } },
    });
    expect(withMs).toEqual({
      done: 1,
      total: 2,
      inProgress: 1,
      nextMilestone: { name: 'Beta cut', targetDate: '2026-08-21', done: 1, total: 2 },
    });
    expect(countsFromIssuesResponse(response(['completed', 'started']))).not.toHaveProperty('nextMilestone');
  });
});
