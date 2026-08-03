/**
 * The pure model behind the session browser — the picker that `Agents: Fork
 * (Pick Session)` opens to choose WHICH session to fork, on this machine or on
 * any fleet device.
 *
 * Rows are grouped by the machine a transcript lives on, because that machine is
 * also where the fork has to run: forking a session that lives on `yosemite-s0`
 * from this laptop would land an agent with no transcript to continue from. The
 * grouping the user sees and the `--device` the launch uses come from the same
 * field (`machine`), so what the picker shows can't drift from where the fork
 * goes.
 */

/** One transcript row as `agents sessions --json` emits it (the fields the browser reads). */
export interface BrowsableSession {
  id: string;
  shortId: string;
  agent: string;
  timestamp: string;
  version?: string;
  account?: string;
  project?: string;
  cwd?: string;
  topic?: string;
  /** Normalized hostname of the machine holding the transcript; absent on older rows. */
  machine?: string;
  messageCount?: number;
}

export interface SessionBrowserGroupRow {
  kind: 'group';
  /** Machine id this group covers. */
  machine: string;
  label: string;
}

export interface SessionBrowserSessionRow {
  kind: 'session';
  session: BrowsableSession;
  /** Machine the transcript lives on (never empty — falls back to the local id). */
  machine: string;
  /** True when the transcript is NOT on this machine, so the fork runs over `--device`. */
  remote: boolean;
  /** True when this is the session the user is currently sitting in. */
  current: boolean;
  label: string;
  description: string;
  detail: string;
}

export type SessionBrowserRow = SessionBrowserGroupRow | SessionBrowserSessionRow;

export interface SessionBrowserOptions {
  /** This machine's normalized id — rows here fork locally. */
  localMachine: string;
  /** The one device whose session listing supplied these rows. */
  browsedMachine?: string;
  /** Session id of the terminal the user invoked from, pinned to the top. */
  currentSessionId?: string | null;
}

/** "just now" / "12 min ago" / "3 hours ago" / "2 days ago"; empty for an unparseable stamp. */
export function formatSessionWhen(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Strip the XML-ish wrappers a topic can carry (system reminders, tool tags). */
export function cleanSessionTopic(topic: string | undefined): string {
  if (!topic) return '(no topic)';
  return topic.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(no topic)';
}

/**
 * The machine a session's fork must run on. Empty `machine` falls back to the
 * explicitly browsed device, or to this machine for the default local listing.
 */
export function sessionMachine(
  session: BrowsableSession,
  localMachine: string,
  browsedMachine?: string,
): string {
  return session.machine?.trim() || browsedMachine || localMachine;
}

/**
 * The `--device` a fork of this session needs: `undefined` for a transcript on
 * this machine (a local launch), the device name otherwise. This is the single
 * seam between "which row did the user pick" and "where does the agent start".
 */
export function forkHostForSession(
  session: BrowsableSession,
  localMachine: string,
  browsedMachine?: string,
): string | undefined {
  const machine = sessionMachine(session, localMachine, browsedMachine);
  return machine === localMachine ? undefined : machine;
}

/** Newest first; a stamp that won't parse sorts last rather than jumping the queue. */
function byRecency(a: BrowsableSession, b: BrowsableSession): number {
  const at = Date.parse(a.timestamp);
  const bt = Date.parse(b.timestamp);
  return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
}

function describeSession(session: BrowsableSession): string {
  const agentLabel = session.version ? `${session.agent}@${session.version}` : session.agent;
  const when = formatSessionWhen(session.timestamp);
  const turns = session.messageCount ? `${session.messageCount} turns` : '';
  return [agentLabel, when, turns, session.account].filter(Boolean).join(' · ');
}

function detailForSession(session: BrowsableSession): string {
  const project = session.project || '-';
  return session.cwd ? `${project}  ${session.cwd}` : project;
}

/**
 * Render the one browsed device's sessions into the label/description/detail
 * triple the QuickPick shows. The CLI applies the ordinary list limit before this
 * model runs; this layer only sorts the returned rows and pins the current session.
 */
export function buildSessionBrowserRows(
  sessions: BrowsableSession[],
  opts: SessionBrowserOptions,
): SessionBrowserRow[] {
  const machine = opts.browsedMachine || opts.localMachine;
  const local = machine === opts.localMachine;
  const shown = sessions.filter(session => !!session?.id).sort(byRecency);
  const currentIdx = opts.currentSessionId
    ? shown.findIndex(s => s.id === opts.currentSessionId || s.shortId === opts.currentSessionId)
    : -1;
  if (currentIdx > 0) shown.unshift(...shown.splice(currentIdx, 1));
  if (shown.length === 0) return [];

  const rows: SessionBrowserRow[] = [{
    kind: 'group',
    machine,
    label: local ? `${machine} · this machine` : machine,
  }];
  for (const session of shown) {
    const current = !!opts.currentSessionId &&
      (session.id === opts.currentSessionId || session.shortId === opts.currentSessionId);
    rows.push({
      kind: 'session',
      session,
      machine,
      remote: !local,
      current,
      label: `${current ? '$(pinned) ' : ''}${session.shortId}  ${cleanSessionTopic(session.topic)}`,
      description: describeSession(session),
      detail: detailForSession(session),
    });
  }
  return rows;
}
