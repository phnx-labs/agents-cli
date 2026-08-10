// Foreman digest: pure function that compresses floor state into a
// short, spoken-friendly summary the voice model can narrate.
//
// Input: list of live terminals (name, elapsed, last-tool, label).
// Output: a compact object the realtime model reads as a function result.
// Keep fields short — every extra token costs latency when the model reads
// back.

import { getTerminalDisplayInfo, prefixToAgentType, SHELL_TITLE } from './utils';

export interface ForemanTerminal {
  name: string;                    // used when kind is not provided (legacy path)
  kind?: string;                   // preferred: 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw'
  label?: string | null;
  sessionId?: string | null;
  project?: string | null;
  openInIde?: boolean;             // true if a live VS Code terminal owns this session
  startedAtMs?: number | null;
  lastActivityMs?: number | null;
  lastTool?: string | null;
  status?: 'idle' | 'working' | 'waiting' | 'blocked' | null;
  task?: string | null;            // first user message or session topic
  recentFiles?: string[];
  recentTools?: string[];
  lastFilePath?: string | null;
  filesEdited?: number;
  toolCalls?: number;
}

// One detailed row per agent that has something to say. Empty fields are
// OMITTED, not null — the voice model verbalizes whatever it sees ("Another
// Claude, no label"), so a null that reaches the payload gets spoken aloud.
// id is an 8-char session prefix: enough for a follow-up focus() call,
// short enough that the model won't try to read a UUID.
export interface ForemanAgentDigest {
  id: string;
  kind: string;
  elapsed: string;
  status: 'idle' | 'working' | 'waiting' | 'blocked';
  label?: string;
  project?: string;
  open_in_ide?: boolean;
  last_tool?: string;
  task?: string;
  recent_files?: string[];
  recent_tools?: string[];
  last_file?: string;
  files_edited?: number;
  tool_calls?: number;
}

// Aggregate for agents with nothing to report (no task, label, or tool
// activity) plus detailed-row overflow. The model speaks this as a count
// ("plus eleven idle") instead of reciting empty rows one by one.
export interface ForemanOthersRollup {
  count: number;
  kinds: Record<string, number>;
  working: number;
  waiting: number;
  idle: number;
  blocked: number;
}

export interface ForemanCloudTask {
  id: string;
  provider: string;
  agent: string;
  status: string;
  prompt: string;
  repo: string | null;
  updated: string;
}

export interface ForemanTeamRollup {
  name: string;
  running: number;
  pending: number;
  completed: number;
  failed: number;
}

export interface ForemanDigest {
  when: string;
  summary: string;
  agents: ForemanAgentDigest[];
  others?: ForemanOthersRollup;
  cloud: ForemanCloudTask[];
  teams: ForemanTeamRollup[];
  concerns: string[];
}

export function humanElapsed(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function deriveStatus(t: ForemanTerminal, now: number): 'idle' | 'working' | 'waiting' | 'blocked' {
  if (t.status) return t.status;
  if (!t.lastActivityMs) return 'idle';
  const sinceActivityMs = now - t.lastActivityMs;
  if (sinceActivityMs > 10 * 60_000) return 'idle';
  if (sinceActivityMs > 3 * 60_000) return 'waiting';
  return 'working';
}

// At most this many detailed rows reach the model. Anything past the cap —
// and any agent with nothing to say — folds into the `others` rollup. The
// model recites whatever rows it receives, so the cap IS the spoken-list cap.
export const MAX_DETAILED_AGENTS = 6;

export function buildForemanDigest(
  terminals: ForemanTerminal[],
  cloud: ForemanCloudTask[] = [],
  teams: ForemanTeamRollup[] = [],
  now: number = Date.now()
): ForemanDigest {
  interface Candidate {
    row: ForemanAgentDigest;
    hasDetail: boolean;
    working: boolean;
    activityMs: number;
  }
  const candidates: Candidate[] = [];
  const kindCounts: Record<string, number> = {};
  const statusCounts = { idle: 0, working: 0, waiting: 0, blocked: 0 };
  const concerns: string[] = [];

  for (const t of terminals) {
    let kind: string;
    if (t.kind) {
      kind = t.kind.toLowerCase();
    } else {
      const info = getTerminalDisplayInfo({ name: t.name });
      if (!info.isAgent || !info.prefix) continue;
      if (info.prefix === SHELL_TITLE) continue;
      kind = prefixToAgentType(info.prefix) ?? info.prefix.toLowerCase();
    }
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;

    const startedMs = t.startedAtMs ?? t.lastActivityMs ?? now;
    const elapsedMs = Math.max(0, now - startedMs);
    const status = deriveStatus(t, now);
    statusCounts[status] += 1;

    const row: ForemanAgentDigest = {
      id: (t.sessionId ?? t.name).slice(0, 8),
      kind,
      elapsed: humanElapsed(elapsedMs),
      status,
    };
    if (t.label) row.label = t.label;
    if (t.project) row.project = t.project;
    if (t.openInIde) row.open_in_ide = true;
    if (t.lastTool) row.last_tool = t.lastTool;
    const task = (t.task ?? '').slice(0, 200);
    if (task) row.task = task;
    const recentFiles = (t.recentFiles ?? []).slice(0, 4).map(shortenPath);
    if (recentFiles.length) row.recent_files = recentFiles;
    const recentTools = (t.recentTools ?? []).slice(0, 4);
    if (recentTools.length) row.recent_tools = recentTools;
    if (t.lastFilePath) row.last_file = shortenPath(t.lastFilePath);
    if (t.filesEdited) row.files_edited = t.filesEdited;
    if (t.toolCalls) row.tool_calls = t.toolCalls;

    candidates.push({
      row,
      // "Something to say": a task, a label, or evidence of tool activity.
      // A bare live pid (status 'working', everything else empty) is not
      // narratable — it becomes "Another Claude, no label" when spoken.
      hasDetail: !!(row.task || row.label || row.last_tool || row.recent_files || row.recent_tools),
      working: status === 'working',
      activityMs: t.lastActivityMs ?? startedMs,
    });

    if (status === 'waiting' && elapsedMs > 10 * 60_000) {
      concerns.push(`${kind}${t.label ? ` "${t.label}"` : ''} waiting ${humanElapsed(elapsedMs)}`);
    }
    if (status === 'blocked') {
      concerns.push(`${kind}${t.label ? ` "${t.label}"` : ''} blocked${t.lastTool ? ` on ${t.lastTool}` : ''}`);
    }
  }

  const detailed = candidates
    .filter((c) => c.hasDetail)
    .sort((a, b) => Number(b.working) - Number(a.working) || b.activityMs - a.activityMs);
  const agents = detailed.slice(0, MAX_DETAILED_AGENTS).map((c) => c.row);

  const rest = detailed.slice(MAX_DETAILED_AGENTS).concat(candidates.filter((c) => !c.hasDetail));
  let others: ForemanOthersRollup | undefined;
  if (rest.length > 0) {
    others = { count: rest.length, kinds: {}, working: 0, waiting: 0, idle: 0, blocked: 0 };
    for (const c of rest) {
      others.kinds[c.row.kind] = (others.kinds[c.row.kind] || 0) + 1;
      others[c.row.status] += 1;
    }
  }

  // Active cloud tasks stand out: they're running even when you close the IDE.
  for (const c of cloud) {
    if (c.status === 'running' || c.status === 'needs_review') {
      concerns.push(`cloud ${c.agent} ${c.status} - ${(c.prompt || '').slice(0, 60)}`);
    }
  }

  const summary = buildSummary(candidates.length, kindCounts, statusCounts, cloud);

  const digest: ForemanDigest = {
    when: new Date(now).toISOString(),
    summary,
    agents,
    cloud,
    teams,
    concerns,
  };
  if (others) digest.others = others;
  return digest;
}

function shortenPath(p: string): string {
  if (!p) return p;
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-2).join('/');
}

function buildSummary(
  total: number,
  kindCounts: Record<string, number>,
  statusCounts: { idle: number; working: number; waiting: number; blocked: number },
  cloud: ForemanCloudTask[]
): string {
  if (total === 0 && cloud.length === 0) return 'floor is empty';
  const parts: string[] = [];
  if (total > 0) {
    const kinds = Object.entries(kindCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => (n > 1 ? `${n} ${k}` : k))
      .join(', ');
    parts.push(`${total} agent${total === 1 ? '' : 's'} local`);
    parts.push(kinds);
  }
  const activeCloud = cloud.filter((c) => c.status === 'running' || c.status === 'needs_review').length;
  if (activeCloud > 0) parts.push(`${activeCloud} cloud`);
  if (statusCounts.blocked > 0) parts.push(`${statusCounts.blocked} blocked`);
  else if (statusCounts.waiting > 0) parts.push(`${statusCounts.waiting} waiting`);
  return parts.join(' - ');
}
