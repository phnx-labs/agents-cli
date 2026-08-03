import { describe, expect, it } from 'vitest';
import { countsFromIssuesResponse, type LinearIssuesResponse } from './linear-project-counts.js';

/** A recorded Linear `issues` response shape (state types only, trimmed). */
function response(types: (string | null | undefined)[]): LinearIssuesResponse {
  return {
    issues: {
      nodes: types.map((t) => (t === undefined ? {} : { state: t === null ? null : { type: t } })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
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
