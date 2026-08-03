import { describe, expect, it } from 'vitest';
import {
  countsFromIssuesResponse,
  fetchLinearProjectCounts,
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
