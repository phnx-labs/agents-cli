/**
 * Per-project Linear issue counts for the `agents projects status` card.
 *
 * When a project definition carries `linear.projectId` (set via
 * `agents projects link <name> --linear`), the card shows one outcome line —
 * `12/30 done · 5 in progress` — counted from the Linear GraphQL API by state
 * TYPE (triage / backlog / unstarted / started / completed / canceled), never
 * hardcoded state names, same convention as `auto-dispatch-linear.ts`.
 *
 * This is a best-effort card enrichment, not an explicit command: every failure
 * (no credential, offline, API error, timeout) degrades to `undefined` and the
 * card simply omits the line — never a hang, never a throw. `--no-remote`
 * skips it (it's network). The API key resolves through the same chain the rest
 * of the stack uses: $LINEAR_API_KEY → macOS Keychain (`resolveLinearApiKey`)
 * → the linear-cli config (`~/.linear-cli/config.json` `apiKey`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLinearApiKey } from './auto-dispatch-linear.js';

const LINEAR_API = 'https://api.linear.app/graphql';
/** Overall budget across all pages — the card must never hang on Linear. */
const TIMEOUT_MS = 8_000;
const PAGE_SIZE = 250;
/** Hard page cap so a pathological project can't page forever within the budget. */
const MAX_PAGES = 10;

/** The counts the card renders. `total` counts every issue in the project. */
export interface LinearProjectCounts {
  /** Issues in a `completed`-type state. */
  done: number;
  /** All issues in the project (any state type, including canceled). */
  total: number;
  /** Issues in a `started`-type state. */
  inProgress: number;
}

/** The GraphQL response shape this module consumes (recorded for the tests). */
export interface LinearIssuesResponse {
  issues?: {
    nodes?: Array<{ state?: { type?: string } | null }>;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  };
}

/**
 * Pure mapping: a Linear issues response → card counts, grouping by state
 * type. Defensive at the boundary — a missing `issues`/`nodes` yields zeros,
 * an issue with no state still counts toward `total`.
 */
export function countsFromIssuesResponse(data: LinearIssuesResponse): LinearProjectCounts {
  const nodes = data.issues?.nodes ?? [];
  let done = 0;
  let inProgress = 0;
  for (const n of nodes) {
    const type = n?.state?.type;
    if (type === 'completed') done++;
    else if (type === 'started') inProgress++;
  }
  return { done, total: nodes.length, inProgress };
}

/** $LINEAR_API_KEY → macOS Keychain → ~/.linear-cli/config.json. Null if none. */
function resolveApiKey(): string | null {
  const fromChain = resolveLinearApiKey();
  if (fromChain) return fromChain;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.linear-cli', 'config.json'), 'utf8'),
    ) as { apiKey?: string };
    return cfg.apiKey?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Fetch issue counts for one Linear project, paging `issues` filtered by
 * project id. One shared AbortController bounds the WHOLE paged fetch at ~8s;
 * any failure (no key, network, API error, abort) returns undefined so the
 * card just omits the line.
 */
export async function fetchLinearProjectCounts(projectId: string): Promise<LinearProjectCounts | undefined> {
  const apiKey = resolveApiKey();
  if (!apiKey) return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const all: Array<{ state?: { type?: string } | null }> = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(LINEAR_API, {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query:
            'query($p:ID!, $after:String){ issues(filter:{ project:{ id:{ eq:$p } } }, first:' +
            PAGE_SIZE +
            ', after:$after){ nodes{ state{ type } } pageInfo{ hasNextPage endCursor } } }',
          variables: { p: projectId, after: after ?? null },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: LinearIssuesResponse; errors?: unknown[] };
      if (json.errors?.length || !json.data) return undefined;
      all.push(...(json.data.issues?.nodes ?? []));
      const pi = json.data.issues?.pageInfo;
      if (!pi?.hasNextPage || !pi.endCursor) break;
      after = pi.endCursor;
    }
    return countsFromIssuesResponse({ issues: { nodes: all } });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
