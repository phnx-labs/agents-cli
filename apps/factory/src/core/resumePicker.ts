// `Agents: Resume` — pure candidate building (no VS Code, no IO).
//
// The picker joins two CLI reads that answer different questions:
//
//   `agents sessions --all --json`     what transcripts exist (durable, resumable)
//   `agents sessions --active --json`  which of them have a process alive right now
//
// The join is what makes the list useful. A transcript alone can't tell you the
// agent is still running with nobody watching it — that is the case the user
// actually wants first: a tmux-hosted agent whose terminal (a VS Code window, a
// Ghostty tab) closed or crashed. The CLI reports it as `viewingIn: 'detached'`;
// everything below ranks off that.

import type { RawActiveSession } from './remoteSessions';
import { normalizeHost } from '../shared/project';

/**
 * Why a session is worth resuming, most urgent first. The order of this union is
 * the display order — see {@link STATE_RANK}.
 */
export type ResumeState =
  /** Process alive in a tmux pane with no client attached: its terminal died. */
  | 'detached'
  /** Deliberately backgrounded via `agents sessions detach` — running headless. */
  | 'background'
  /** Was backgrounded; the headless continuation has since exited. */
  | 'parked'
  /** No live process — a durable transcript you can pick up again. */
  | 'idle'
  /** Live AND on screen somewhere (`viewingIn` names the app/tab). Resuming opens a second view. */
  | 'watched';

const STATE_RANK: Record<ResumeState, number> = {
  detached: 0,
  background: 1,
  parked: 2,
  idle: 3,
  watched: 4,
};

/** Human wording for each state, used as the picker's group headers. */
export const STATE_HEADINGS: Record<ResumeState, string> = {
  detached: 'Detached — still running, no terminal attached',
  background: 'Background — running headless',
  parked: 'Parked — backgrounded, process exited',
  idle: 'Recent',
  watched: 'Already open elsewhere',
};

/**
 * Persisted snapshot behind the resume picker's stale-while-revalidate flow:
 * the picker renders the last candidate list instantly (the live fleet read
 * takes seconds over SSH) and swaps items in place when the refresh lands.
 */
export interface ResumePickerCache {
  candidates: ResumeCandidate[];
  fetchedAt: number;
}

export const RESUME_PICKER_CACHE_KEY = 'agents.resumePicker.v1';

/** The subset of `agents sessions --all --json` (SessionMeta) the picker reads. */
export interface RecentSessionRow {
  id?: string;
  shortId?: string;
  agent?: string;
  version?: string;
  account?: string;
  project?: string;
  cwd?: string;
  topic?: string;
  label?: string;
  timestamp?: string;
  lastActivity?: string;
  machine?: string;
  messageCount?: number;
}

/** One row in the resume picker. */
export interface ResumeCandidate {
  id: string;
  shortId: string;
  /** Agent key as the CLI names it ('claude', 'codex', 'grok', …). */
  agent: string;
  /** Version home the session ran under, so it resumes under the same one. */
  version?: string;
  account?: string;
  project?: string;
  cwd?: string;
  topic?: string;
  state: ResumeState;
  /** Where the CLI says it is being watched ('codium tab 3'); '' when nowhere. */
  viewingIn: string;
  /** Device the session lives on, normalized; '' when it is this machine. */
  host: string;
  /** Epoch ms of the most recent activity — the sort key inside a state group. */
  lastActivityMs: number;
  /** Live pid, 0 when the session has no process. */
  pid: number;
}

/** Live-session ids keyed by session id, with the last row winning on duplicates. */
function indexLive(live: RawActiveSession[]): Map<string, RawActiveSession> {
  const out = new Map<string, RawActiveSession>();
  for (const row of live) {
    if (row?.sessionId) out.set(row.sessionId, row);
  }
  return out;
}

/**
 * Which resume state a session is in, given its live row (undefined when no
 * process is running).
 *
 * `presence` covers the deliberate detach/attach axis the CLI owns; `viewingIn`
 * covers the accidental one — a live tmux pane nobody is attached to. A live
 * session that is neither backgrounded nor visible anywhere is `detached`
 * whenever the CLI resolved a pane for it; without a pane (a bare TTY run) there
 * is nothing to re-attach to, so it reads as `watched` — it is someone's
 * foreground process, just not one we can locate.
 */
export function classifyResumeState(live: RawActiveSession | undefined): ResumeState {
  if (!live) return 'idle';
  if (live.presence === 'background') return 'background';
  if (live.presence === 'parked') return 'parked';
  return live.viewingIn === 'detached' ? 'detached' : 'watched';
}

/**
 * Device ids go through the SAME normalizer the rest of the extension uses. A
 * second hand-rolled one drifts on any hostname that isn't plain alphanumeric
 * (`mac_mini` -> `mac-mini` here but `mac_mini` there), and a mismatch is not
 * cosmetic: it makes a LOCAL session look remote, so the picker would resume it
 * over SSH against a host alias that may not exist.
 */
function normalizeMachine(value: string | undefined): string {
  return normalizeHost(value || '');
}

function toMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const t = v?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * Join the durable listing with the live one into ranked resume candidates.
 *
 * A live session with no durable row still gets a candidate synthesized from the
 * live payload: `--all -n <limit>` is capped, and the detached session a user is
 * hunting for is often an OLD one whose terminal died hours ago — dropping it
 * would hide exactly the row this command exists to surface.
 *
 * `localMachine` is the normalized id of the machine the extension runs on; a
 * candidate on any other device carries it as {@link ResumeCandidate.host} so the
 * caller resumes it over SSH rather than starting a fresh local agent against an
 * id this box has never seen.
 */
export function buildResumeCandidates(
  recent: RecentSessionRow[],
  live: RawActiveSession[],
  localMachine: string,
): ResumeCandidate[] {
  const liveById = indexLive(live);
  const local = normalizeMachine(localMachine);
  const out: ResumeCandidate[] = [];
  const seen = new Set<string>();

  for (const row of recent) {
    const id = row.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const liveRow = liveById.get(id);
    const machine = normalizeMachine(row.machine || liveRow?.machine);
    out.push({
      id,
      shortId: row.shortId || id.slice(0, 8),
      agent: row.agent || liveRow?.kind || '',
      version: row.version,
      account: row.account,
      project: row.project,
      cwd: row.cwd || liveRow?.cwd,
      topic: firstText(row.label, row.topic, liveRow?.topic),
      state: classifyResumeState(liveRow),
      viewingIn: liveRow?.viewingIn && liveRow.viewingIn !== 'detached' ? liveRow.viewingIn : '',
      host: machine && machine !== local ? machine : '',
      lastActivityMs: Math.max(
        toMs(row.lastActivity),
        toMs(row.timestamp),
        liveRow?.lastActivityMs ?? 0,
      ),
      pid: liveRow?.pid ?? 0,
    });
  }

  for (const [id, liveRow] of liveById) {
    if (seen.has(id)) continue;
    seen.add(id);
    const machine = normalizeMachine(liveRow.machine);
    out.push({
      id,
      shortId: id.slice(0, 8),
      agent: liveRow.kind || '',
      project: liveRow.cwd ? liveRow.cwd.split('/').filter(Boolean).pop() : undefined,
      cwd: liveRow.cwd,
      topic: firstText(liveRow.label, liveRow.topic),
      state: classifyResumeState(liveRow),
      viewingIn: liveRow.viewingIn && liveRow.viewingIn !== 'detached' ? liveRow.viewingIn : '',
      host: machine && machine !== local ? machine : '',
      lastActivityMs: liveRow.lastActivityMs ?? liveRow.startedAtMs ?? 0,
      pid: liveRow.pid ?? 0,
    });
  }

  return sortResumeCandidates(out);
}

/** Detached first, then by most recent activity inside each state group. */
export function sortResumeCandidates(candidates: ResumeCandidate[]): ResumeCandidate[] {
  return [...candidates].sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rank !== 0) return rank;
    if (b.lastActivityMs !== a.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
    return a.shortId.localeCompare(b.shortId);
  });
}

/**
 * The `Agents: Resume (Pick Session)` set: sessions nobody is watching right
 * now — the abandoned ones. A `watched` session already has a terminal on some
 * host, so picking it here would double-attach it; the plain `Agents: Resume`
 * picker still lists every state. Order is preserved (the input is already
 * ranked by {@link sortResumeCandidates}).
 */
export function abandonedCandidates(candidates: ResumeCandidate[]): ResumeCandidate[] {
  return candidates.filter((c) => c.state !== 'watched');
}

/**
 * The candidates checked when the picker opens: the crashed ones. Everything
 * else is a deliberate choice the user makes by ticking it — auto-selecting a
 * session someone is watching would double-attach it, and auto-selecting a
 * headless background run would drag it back into the foreground unasked.
 */
export function defaultPickedIds(candidates: ResumeCandidate[]): string[] {
  return candidates.filter((c) => c.state === 'detached').map((c) => c.id);
}

/** A phrase must lead this many topics before it counts as boilerplate. */
const SHARED_PREFIX_MIN_OCCURRENCES = 3;
/** Longest phrase (in words) considered — beyond this a "prefix" is the topic. */
const SHARED_PREFIX_MAX_WORDS = 6;

/**
 * Leading phrases that several topics share carry no signal: they are the
 * harness's own boilerplate ("Resume previous work: …", "Continue Previous
 * Session …", "New Session"), not something a human wrote to tell two sessions
 * apart. A picker showing 122 rows of it is unreadable, so find the phrases
 * that recur across the visible set and let the label drop them.
 *
 * Data-driven on purpose — a hardcoded list of known prefixes would go stale
 * the moment a harness reworded its own boilerplate.
 *
 * Returned longest-first so {@link stripSharedPrefix} strips the most specific
 * match rather than a shorter phrase nested inside it.
 */
export function sharedTopicPrefixes(
  topics: readonly string[],
  minOccurrences = SHARED_PREFIX_MIN_OCCURRENCES,
): string[] {
  const counts = new Map<string, number>();
  for (const topic of topics) {
    const words = topic.trim().split(/\s+/).filter(Boolean);
    // Stop one word short of the whole topic: a phrase covering every word is
    // the topic itself, and stripping it would blank a row whose text happens
    // to repeat rather than one carrying boilerplate.
    const limit = Math.min(SHARED_PREFIX_MAX_WORDS, words.length - 1);
    for (let n = 2; n <= limit; n++) {
      const phrase = words.slice(0, n).join(' ');
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minOccurrences)
    .map(([phrase]) => phrase)
    .sort((a, b) => b.length - a.length);
}

/**
 * Remove the longest shared prefix from `topic`, plus the punctuation it left
 * behind. A topic that is ENTIRELY boilerplate strips to '' on purpose, so
 * {@link distinctiveTopic} falls through to a field that identifies the row —
 * a bare "Resume previous work:" names nothing. Nothing is lost when a phrase
 * recurs but is never extended: {@link sharedTopicPrefixes} does not mint a
 * phrase covering a topic's every word, so such a topic has no prefix to match.
 */
export function stripSharedPrefix(topic: string, prefixes: readonly string[]): string {
  const trimmed = topic.trim();
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length).replace(/^[\s:\-–—,.]+/, '').trim();
    }
  }
  return trimmed;
}

/**
 * The text a row shows for a session, after shared boilerplate is stripped.
 *
 * Falls through to the fields that actually identify a session when the topic
 * is absent or was pure boilerplate — the project, then the working directory's
 * last segment. Returns '' when nothing distinctive survives, so the caller can
 * render an explicit placeholder instead of a misleading fragment.
 */
export function distinctiveTopic(c: ResumeCandidate, prefixes: readonly string[]): string {
  const stripped = c.topic ? stripSharedPrefix(c.topic, prefixes) : '';
  if (stripped) return stripped;
  if (c.project) return c.project;
  const leaf = c.cwd ? c.cwd.split('/').filter(Boolean).pop() : undefined;
  return leaf ?? '';
}
