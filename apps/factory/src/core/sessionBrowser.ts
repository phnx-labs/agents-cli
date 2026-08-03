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
  /** This machine's normalized id — the group that sorts first and forks locally. */
  localMachine: string;
  /** Session id of the terminal the user invoked from, pinned to the top of its group. */
  currentSessionId?: string | null;
  /** Cap per machine group; omit for no cap. */
  limitPerMachine?: number;
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
 * The machine a session's fork must run on. Empty `machine` means the row came
 * from a listing that predates machine tagging — those are only ever produced by
 * the local index, so they belong to this machine.
 */
export function sessionMachine(session: BrowsableSession, localMachine: string): string {
  return session.machine?.trim() || localMachine;
}

/**
 * The `--device` a fork of this session needs: `undefined` for a transcript on
 * this machine (a local launch), the device name otherwise. This is the single
 * seam between "which row did the user pick" and "where does the agent start".
 */
export function forkHostForSession(session: BrowsableSession, localMachine: string): string | undefined {
  const machine = sessionMachine(session, localMachine);
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
 * Group the sessions by machine and render each into the label/description/detail
 * triple the QuickPick shows. This machine comes first (it is the common case and
 * the only one that forks without SSH), remaining devices follow alphabetically so
 * the order is stable between openings rather than shuffling with fleet load.
 */
export function buildSessionBrowserRows(
  sessions: BrowsableSession[],
  opts: SessionBrowserOptions,
): SessionBrowserRow[] {
  const byMachine = new Map<string, BrowsableSession[]>();
  for (const session of sessions) {
    if (!session?.id) continue;
    const machine = sessionMachine(session, opts.localMachine);
    const bucket = byMachine.get(machine);
    if (bucket) bucket.push(session);
    else byMachine.set(machine, [session]);
  }

  const machines = [...byMachine.keys()].sort((a, b) => {
    if (a === opts.localMachine) return -1;
    if (b === opts.localMachine) return 1;
    return a.localeCompare(b);
  });

  const rows: SessionBrowserRow[] = [];
  for (const machine of machines) {
    const local = machine === opts.localMachine;
    const group = [...(byMachine.get(machine) ?? [])].sort(byRecency);

    // The session the user is sitting in is what they most often want to fork —
    // float it to the top of its own machine's group, wherever its timestamp fell.
    const currentIdx = opts.currentSessionId
      ? group.findIndex(s => s.id === opts.currentSessionId || s.shortId === opts.currentSessionId)
      : -1;
    if (currentIdx > 0) group.unshift(...group.splice(currentIdx, 1));

    const shown = opts.limitPerMachine ? group.slice(0, opts.limitPerMachine) : group;
    if (shown.length === 0) continue;

    rows.push({
      kind: 'group',
      machine,
      label: local ? `${machine} · this machine` : machine,
    });
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
  }
  return rows;
}
