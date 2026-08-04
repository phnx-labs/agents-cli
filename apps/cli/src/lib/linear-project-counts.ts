/**
 * Per-project Linear issue counts for the `agents projects status` card.
 *
 * When a project definition carries `linear.projectId` (set via
 * `agents projects link <name> --linear`), the card shows one outcome line —
 * `12/30 done · 5 in progress` — counted from the Linear GraphQL API by state
 * TYPE (triage / backlog / unstarted / started / completed / canceled), never
 * hardcoded state names, same convention as `auto-dispatch-linear.ts`.
 *
 * The same fetch also yields the **next milestone** — the earliest-dated
 * milestone with unfinished issues — because each issue node carries its
 * `projectMilestone`. A percentage tells you how far along a project is; the
 * milestone tells you what it is due to hit next, which is the thing a person
 * actually plans around. Deriving it here costs no extra request.
 *
 * This is a best-effort card enrichment, not an explicit command: every failure
 * (no credential, offline, API error, timeout) degrades to `undefined` and the
 * card simply omits the line — never a hang, never a throw. `--no-remote`
 * skips it (it's network). The API key resolves through the same chain the rest
 * of the stack uses: $LINEAR_API_KEY → macOS Keychain (`resolveLinearApiKey`)
 * → the linear-cli config (`~/.linear-cli/config.json` `apiKey`).
 *
 * Paging is capped (10 × 250 issues) so a pathological project can't burn the
 * budget; a capped fetch reports `truncated: true` and the card renders the
 * total as a lower bound (`2500+ done`), never as the complete count.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLinearApiKey } from './auto-dispatch-linear.js';
import { isRateLimited, noteRateLimited, parseRateLimitReset, readCached, writeCached } from './linear-cache.js';

const LINEAR_API = 'https://api.linear.app/graphql';
/** Overall budget across all pages — the card must never hang on Linear. */
const TIMEOUT_MS = 8_000;
const PAGE_SIZE = 250;
/** Hard page cap so a pathological project can't page forever within the budget. */
const MAX_PAGES = 10;

/**
 * The next checkpoint the project is working toward: the earliest-dated
 * milestone that still has unfinished issues. A percentage says how far along
 * the project is; this says what it is due to hit next.
 */
export interface LinearMilestone {
  name: string;
  /** `YYYY-MM-DD` as Linear stores it. Absent when the milestone has no date. */
  targetDate?: string;
  /** Issues in this milestone in a `completed`-type state. */
  done: number;
  /**
   * Issues assigned to this milestone. Legitimately `0` — a milestone can be
   * declared with a date long before any issue is filed under it (that is the
   * state of every milestone in this repo's own Linear project), and such a
   * milestone is still the next checkpoint. The card omits the fraction rather
   * than printing a meaningless `0/0`.
   */
  total: number;
  /** True when Linear itself flags this as the project's next milestone. */
  isNext?: boolean;
}

/** A milestone as the project declares it, independent of any issue. */
export interface LinearMilestoneNode {
  id?: string;
  name?: string;
  targetDate?: string | null;
  /**
   * Linear's own marker. Observed values: `"next"` (it flags exactly one) and
   * `"unstarted"`. Treated as an opaque string and only compared to `"next"` —
   * the enum is not documented as closed, so switching exhaustively on it would
   * break the day Linear adds a value.
   */
  status?: string | null;
}

/** The counts the card renders. `total` counts every issue in the project. */
export interface LinearProjectCounts {
  /** Issues in a `completed`-type state. */
  done: number;
  /** All issues in the project (any state type, including canceled). */
  total: number;
  /** Issues in a `started`-type state. */
  inProgress: number;
  /**
   * True when the page cap cut the fetch short — `total` is then a LOWER
   * bound (rendered `2500+`), never presented as the complete count.
   */
  truncated?: boolean;
  /**
   * True when this answer came from the cache after a failed or skipped fetch.
   * The card labels it rather than dropping the line — a populated Linear row
   * that silently vanishes on one timeout is the defect this replaces.
   */
  stale?: boolean;
  /**
   * Every milestone the project declares, in the order the card shows them:
   * unfinished first by target date, then the finished ones. A project with
   * three checkpoints has three; showing only the next one hides the shape of
   * the plan, which is what `projects view` exists to show.
   */
  milestones?: LinearMilestone[];
  /**
   * The one the project is working toward — `milestones[0]` when there is an
   * unfinished one. Kept as its own field because the compact card shows only
   * this, while `view` shows the whole list.
   */
  nextMilestone?: LinearMilestone;
}

/** One issue node as the query selects it. */
export interface LinearIssueNode {
  state?: { type?: string } | null;
  projectMilestone?: { id?: string; name?: string; targetDate?: string | null } | null;
}

/** The GraphQL response shape this module consumes (recorded for the tests). */
export interface LinearIssuesResponse {
  issues?: {
    nodes?: LinearIssueNode[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  };
  /** Only the FIRST page asks for this — the milestone list does not paginate. */
  project?: { projectMilestones?: { nodes?: LinearMilestoneNode[] } } | null;
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
  const counts: LinearProjectCounts = { done, total: nodes.length, inProgress };
  const declared = data.project?.projectMilestones?.nodes ?? [];
  const ordered = orderedMilestones(declared, nodes);
  if (ordered.length) counts.milestones = ordered;
  const next = nextMilestone(declared, nodes);
  if (next) counts.nextMilestone = next;
  return counts;
}

/**
 * Pick the milestone the project is working toward next.
 *
 * The **declared** list is authoritative for which milestones exist, their
 * names, and their dates; issues only supply progress. Deriving the list from
 * issues instead looks tempting (it costs no extra request) and is wrong: a
 * milestone with nothing filed under it yet would be invisible, and that is the
 * common case — every milestone in this repo's own Linear project has zero
 * issues assigned, so an issue-derived list showed nothing at all.
 *
 * Next = the earliest-dated milestone that is not finished. A milestone with no
 * issues counts as unfinished (it is upcoming work, not completed work). Undated
 * milestones sort last, ties break by declaration order, so the answer is stable.
 */
export function orderedMilestones(
  declared: LinearMilestoneNode[],
  nodes: LinearIssueNode[],
): LinearMilestone[] {
  // Progress per milestone id, from whatever issues do carry one.
  const progress = new Map<string, { done: number; total: number }>();
  for (const n of nodes) {
    const id = n?.projectMilestone?.id;
    if (!id) continue;
    const p = progress.get(id) ?? { done: 0, total: 0 };
    p.total++;
    if (n.state?.type === 'completed') p.done++;
    progress.set(id, p);
  }
  const all = declared
    .map((d, order) => {
      if (!d?.id || typeof d.name !== 'string' || !d.name) return undefined;
      const p = progress.get(d.id) ?? { done: 0, total: 0 };
      const m: LinearMilestone & { order: number } = { name: d.name, done: p.done, total: p.total, order };
      if (d.targetDate) m.targetDate = d.targetDate;
      if (d.status === 'next') m.isNext = true;
      return m;
    })
    .filter((m): m is LinearMilestone & { order: number } => m !== undefined);
  // total 0 means "declared, nothing filed yet" — unfinished, not done.
  const open = (m: LinearMilestone) => m.total === 0 || m.done < m.total;
  all.sort((a, b) => {
    // Unfinished before finished: what is still ahead is what a reader is
    // scanning for.
    if (open(a) !== open(b)) return open(a) ? -1 : 1;
    if (a.targetDate && b.targetDate) return a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.order - b.order;
    if (a.targetDate) return -1;
    if (b.targetDate) return 1;
    return a.order - b.order;
  });
  return all.map(({ order: _order, ...m }) => m);
}

/**
 * The milestone the project is working toward next.
 *
 * Linear flags one itself (`status: "next"`), and that is the answer the user
 * sees in Linear's own UI, so it wins when present. Only when nothing is
 * flagged does this fall back to "earliest-dated unfinished", which is a
 * reasonable guess but still a guess.
 */
export function nextMilestone(
  declared: LinearMilestoneNode[],
  nodes: LinearIssueNode[],
): LinearMilestone | undefined {
  const ordered = orderedMilestones(declared, nodes);
  const open = ordered.filter((m) => m.total === 0 || m.done < m.total);
  return open.find((m) => m.isNext) ?? open[0];
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
 * card just omits the line. `fetchPage` is injectable for tests — the
 * accumulator (cursor hand-off, cap) is the risky logic, not the HTTP.
 */
export async function fetchLinearProjectCounts(
  projectId: string,
  fetchPage: (projectId: string, after: string | undefined, signal: AbortSignal) => Promise<LinearIssuesResponse | undefined> = fetchLinearIssuesPage,
  nowMs: number = Date.now(),
): Promise<LinearProjectCounts | undefined> {
  // Requests are the scarce budget (2500/hr; complexity is untouched), and this
  // pages up to 10 of them per project per call. Serve a fresh snapshot without
  // spending any.
  const cached = readCached<LinearProjectCounts>(projectId, nowMs);
  if (cached && !cached.stale) return cached.value;
  // A prior 429 said there is nothing left to spend — don't spend one finding
  // that out again. Fall through to the stale snapshot rather than no line.
  if (isRateLimited(nowMs)) return cached ? { ...cached.value, stale: true } : undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const all: LinearIssueNode[] = [];
    // Declared on the project, not on its issues — only page 0 asks for it.
    let declared: LinearMilestoneNode[] = [];
    let after: string | undefined;
    let truncated = false;
    for (let page = 0; ; page++) {
      const data = await fetchPage(projectId, after, ctrl.signal);
      // A failed fetch keeps the last good answer on screen, marked stale,
      // instead of the line vanishing. One 8s timeout must not blank a chip
      // that was populated a minute ago — the rule `mergeAuthHealthEntries`
      // already encodes for account health.
      if (!data) return cached ? { ...cached.value, stale: true } : undefined;
      if (page === 0) declared = data.project?.projectMilestones?.nodes ?? [];
      all.push(...(data.issues?.nodes ?? []));
      const pi = data.issues?.pageInfo;
      if (!pi?.hasNextPage || !pi.endCursor) break;
      if (page + 1 >= MAX_PAGES) {
        // The cap cut the fetch short — total is a lower bound, say so.
        truncated = true;
        break;
      }
      after = pi.endCursor;
    }
    const counts: LinearProjectCounts = {
      ...countsFromIssuesResponse({
        issues: { nodes: all },
        project: { projectMilestones: { nodes: declared } },
      }),
      ...(truncated ? { truncated } : {}),
    };
    writeCached(projectId, counts, nowMs);
    return counts;
  } catch {
    return cached ? { ...cached.value, stale: true } : undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** One real GraphQL page; undefined on any HTTP/API-level failure. */
async function fetchLinearIssuesPage(
  projectId: string,
  after: string | undefined,
  signal: AbortSignal,
): Promise<LinearIssuesResponse | undefined> {
  const apiKey = resolveApiKey();
  if (!apiKey) return undefined;
  // The declared-milestone list rides along on the FIRST page only — it does
  // not paginate, and re-requesting it per page would spend up to MAX_PAGES
  // copies of the same answer.
  const issuesSelection =
    'issues(filter:{ project:{ id:{ eq:$p } } }, first:' +
    PAGE_SIZE +
    ', after:$after){ nodes{ state{ type } projectMilestone{ id } } pageInfo{ hasNextPage endCursor } }';
  const milestonesSelection = 'project(id:$pid){ projectMilestones(first:50){ nodes{ id name targetDate status } } }';
  const first = after === undefined;
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: first
        ? `query($p:ID!, $pid:String!, $after:String){ ${issuesSelection} ${milestonesSelection} }`
        : `query($p:ID!, $after:String){ ${issuesSelection} }`,
      variables: first
        ? { p: projectId, pid: projectId, after: null }
        : { p: projectId, after },
    }),
    signal,
  });
  if (res.status === 429) {
    // Record when the budget refills so later runs skip the call entirely
    // rather than spending one of the zero remaining requests to be told so.
    // The header is epoch milliseconds; absent or unparseable, back off a TTL.
    const now = Date.now();
    noteRateLimited(parseRateLimitReset(res.headers.get('x-ratelimit-requests-reset'), now), now);
    return undefined;
  }
  if (!res.ok) return undefined;
  const json = (await res.json()) as { data?: LinearIssuesResponse; errors?: unknown[] };
  if (json.errors?.length || !json.data) return undefined;
  return json.data;
}
