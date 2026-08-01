/**
 * Activity log -- an append-only, per-session stream of agent-semantic events
 * (plan created, PR opened, worktree created, sub-agent spawned, file edited).
 *
 * This is the counterpart to the feed block store: the block store is
 * last-writer-wins STATE ("this agent is waiting on you"), while the activity
 * log is an append-only EVENT stream ("this agent did X at T"). Together they
 * let `agents feed` show both open decisions and a running activity lane
 * without ever re-parsing session transcripts -- events are emitted at hook
 * time by `11-activity-log.py` and read back by tailing the log.
 *
 * Layout: <activityDir>/<sessionId>.jsonl  (one append-only file per session)
 *   Each line is one {@link ActivityEvent}. Files are keyed by session so a
 *   plain O_APPEND write is race-free (a session has a single writer process).
 *
 * Event tiers:
 *   - `milestone` -- recognizable deliverables, always surfaced individually.
 *   - `activity`  -- routine work (file edits), collapsed to counts by readers.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import chalk from 'chalk';
import { relTime, truncate } from './format.js';
import { getActivityDir, getUserAgentsDir } from './state.js';
// Type-only import: no runtime dependency on events.ts, so no import cycle
// (events.ts / event-stream.ts import THIS module at runtime).
import type { EventRecord } from './events.js';

/** Recognizable milestone events, ordered first in any activity lane. */
export type MilestoneEvent =
  | 'plan.created'
  | 'pr.opened'
  | 'pr.merged'
  | 'worktree.created'
  | 'worktree.removed'
  | 'commit.created'
  | 'pushed'
  | 'subagent.spawned'
  | 'artifact.created'
  /** Deliberate agent-authored progress post (`agents feed post`). */
  | 'status.posted';

/** Routine activity events, collapsed to counts by readers. */
export type ActivityKind = 'file.edited';

export type ActivityEventKind = MilestoneEvent | ActivityKind;

export type ActivityTier = 'milestone' | 'activity';

/** The set of milestone events, for tier classification and ordering. */
export const MILESTONE_EVENTS: readonly MilestoneEvent[] = [
  'plan.created',
  'pr.opened',
  'pr.merged',
  'worktree.created',
  'worktree.removed',
  'commit.created',
  'pushed',
  'subagent.spawned',
  'artifact.created',
  'status.posted',
];

const MILESTONE_SET = new Set<string>(MILESTONE_EVENTS);

export function tierForEvent(event: string): ActivityTier {
  return MILESTONE_SET.has(event) ? 'milestone' : 'activity';
}

export interface ActivityEvent {
  /** Schema version, for forward-compatible readers. */
  v: number;
  /** ISO-8601 timestamp of the event. */
  ts: string;
  /** Event kind (see {@link ActivityEventKind}). */
  event: ActivityEventKind | string;
  /** Coarse importance tier -- stamped by the writer, recomputed if absent. */
  tier: ActivityTier;
  /** Owning session id. */
  sessionId: string;
  /** Mailbox id for routing/joins (falls back to sessionId). */
  mailboxId: string;
  /** Short, normalized hostname the event fired on. */
  host: string;
  /** Runtime label (headless, tmux, cloud, ...). */
  runtime: string;
  /** Working directory at event time -- the join key to a project/git repo. */
  cwd?: string;
  /** Agent that produced the event (claude, codex, ...). */
  agent?: string;
  /** Tool that triggered the event (Bash, Task, ExitPlanMode, feed.post, ...). */
  tool?: string;
  /** One-line human summary (plan title, PR command, sub-agent role, status text). */
  detail?: string;
  /** Extracted URL when the event has one (e.g. the opened PR). */
  url?: string;
  /** Auto-stamped process identity for deliberate posts (from pid registry / env). */
  pid?: number;
  /** Spawn-time join key (`AGENT_LAUNCH_ID`) when known. */
  launchId?: string;
  /** Factory terminal id when the launch inherited one. */
  terminalId?: string;
  /** `$TMUX_PANE` at launch when recorded. */
  tmuxPane?: string;
}

function activityPath(root: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!safe) throw new Error(`Invalid activity session id: ${sessionId}`);
  return path.join(root, `${safe}.jsonl`);
}

/**
 * Append one event to a session's activity log. Primarily the Python hook
 * writes these at runtime; this TS writer exists for tests and any in-process
 * emitter. Uses O_APPEND so concurrent appends never interleave a line.
 */
export function appendActivityEvent(
  event: Omit<ActivityEvent, 'v' | 'tier'> & { v?: number; tier?: ActivityTier },
  root?: string,
): void {
  const dir = root ?? getActivityDir();
  fs.mkdirSync(dir, { recursive: true });
  const record: ActivityEvent = {
    v: event.v ?? 1,
    tier: event.tier ?? tierForEvent(event.event),
    ...event,
  } as ActivityEvent;
  fs.appendFileSync(activityPath(dir, event.sessionId), `${JSON.stringify(record)}\n`, { mode: 0o644 });
}

function parseLine(line: string): ActivityEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<ActivityEvent>;
    if (!parsed.event || !parsed.sessionId || !parsed.ts) return undefined;
    return {
      v: parsed.v ?? 1,
      ts: parsed.ts,
      event: parsed.event,
      tier: parsed.tier ?? tierForEvent(parsed.event),
      sessionId: parsed.sessionId,
      mailboxId: parsed.mailboxId ?? parsed.sessionId,
      host: parsed.host ?? 'unknown',
      runtime: parsed.runtime ?? 'headless',
      cwd: parsed.cwd,
      agent: parsed.agent,
      tool: parsed.tool,
      detail: parsed.detail,
      url: parsed.url,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      launchId: parsed.launchId,
      terminalId: parsed.terminalId,
      tmuxPane: parsed.tmuxPane,
    };
  } catch {
    return undefined; // skip corrupt / partial lines (fail-open reader)
  }
}

/** Read the tail of a file as UTF-8, bounded to the last `maxBytes`. */
function readTail(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf-8');
    // Drop a leading partial line when we started mid-file.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Read all events for one session (bounded tail). */
export function readSessionActivity(sessionId: string, root?: string, maxBytes = 256 * 1024): ActivityEvent[] {
  const dir = root ?? getActivityDir();
  const text = readTail(activityPath(dir, sessionId), maxBytes);
  const out: ActivityEvent[] = [];
  for (const line of text.split('\n')) {
    const ev = parseLine(line);
    if (ev) out.push(ev);
  }
  return out;
}

/** List session ids that have an activity log. */
export function listActivitySessions(root?: string): string[] {
  const dir = root ?? getActivityDir();
  try {
    return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -'.jsonl'.length));
  } catch {
    return [];
  }
}

export interface RecentActivityOptions {
  /** Only include events at or after this epoch-ms. */
  sinceMs?: number;
  /** Cap the number of returned events (most recent first). */
  limit?: number;
  /** Override the activity dir (tests). */
  root?: string;
  /** Per-session tail budget in bytes. */
  maxBytesPerSession?: number;
}

/**
 * Merge recent events across every session's log, newest first. Reads only the
 * tail of each file, so cost scales with active sessions, not transcript size.
 */
export function readRecentActivity(opts: RecentActivityOptions = {}): ActivityEvent[] {
  const dir = opts.root ?? getActivityDir();
  const sinceMs = opts.sinceMs ?? 0;
  const all: ActivityEvent[] = [];
  for (const sessionId of listActivitySessions(dir)) {
    for (const ev of readSessionActivity(sessionId, dir, opts.maxBytesPerSession)) {
      const t = Date.parse(ev.ts);
      if (Number.isFinite(t) && t >= sinceMs) all.push(ev);
    }
  }
  all.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return typeof opts.limit === 'number' ? all.slice(0, opts.limit) : all;
}

export interface CollapsedActivity {
  /** Milestone events, individually preserved, newest first. */
  milestones: ActivityEvent[];
  /** Routine events rolled up to counts, e.g. { 'file.edited': 12 }. */
  counts: Record<string, number>;
  /** Number of sub-agents spawned across the collapsed set. */
  subagentCount: number;
}

/**
 * Split a chronological event list into individual milestones plus a
 * count map for the routine (tier-2) events, so a reader shows recognizable
 * deliverables in full and collapses the noise.
 */
export function collapseActivity(events: ActivityEvent[]): CollapsedActivity {
  const milestones: ActivityEvent[] = [];
  const counts: Record<string, number> = {};
  let subagentCount = 0;
  for (const ev of events) {
    if (tierForEvent(ev.event) === 'milestone') {
      milestones.push(ev);
      if (ev.event === 'subagent.spawned') subagentCount += 1;
    } else {
      counts[ev.event] = (counts[ev.event] ?? 0) + 1;
    }
  }
  return { milestones, counts, subagentCount };
}

// ---------------------------------------------------------------------------
// Bridge into the unified event stream (lib/event-stream.ts)
// ---------------------------------------------------------------------------

/**
 * Normalize one activity event into the shared {@link EventRecord} shape so the
 * agent-semantic stream reads through the same reader as operational events.
 * `module` is stamped `activity` so `--module` filters partition the two cleanly.
 */
export function activityEventToRecord(ev: ActivityEvent): EventRecord {
  return {
    ts: ev.ts,
    tz: '',
    tzName: '',
    hostname: ev.host,
    platform: process.platform,
    arch: process.arch,
    pid: ev.pid ?? 0,
    ppid: 0,
    event: ev.event as EventRecord['event'],
    level: 'info',
    caller: ev.tool === 'feed.post' ? 'agent' : 'hook',
    session: ev.sessionId,
    osUser: ev.agent ?? 'agent',
    transport: 'local',
    // payload
    agent: ev.agent,
    sessionId: ev.sessionId,
    cwd: ev.cwd,
    module: 'activity',
    tool: ev.tool,
    detail: ev.detail,
    url: ev.url,
    tier: ev.tier,
    ...(ev.launchId ? { launchId: ev.launchId } : {}),
    ...(ev.terminalId ? { terminalId: ev.terminalId } : {}),
    ...(ev.tmuxPane ? { tmuxPane: ev.tmuxPane } : {}),
  } as EventRecord;
}

/** Read recent activity across sessions as unified {@link EventRecord}s. */
export function readActivityAsEventRecords(opts: RecentActivityOptions = {}): EventRecord[] {
  return readRecentActivity(opts).map(activityEventToRecord);
}

// ---------------------------------------------------------------------------
// Rendering (shared by `agents activity` and `agents feed`)
// ---------------------------------------------------------------------------

/** Glyph + color + human label per event, so the lane reads at a glance. */
export const EVENT_STYLE: Record<string, { glyph: string; color: (s: string) => string; label: string }> = {
  'plan.created': { glyph: '◆', color: chalk.cyan, label: 'plan created' },
  'pr.opened': { glyph: '⇡', color: chalk.green, label: 'PR opened' },
  'pr.merged': { glyph: '✔', color: chalk.green, label: 'PR merged' },
  'worktree.created': { glyph: '⌥', color: chalk.blue, label: 'worktree created' },
  'worktree.removed': { glyph: '⌦', color: chalk.gray, label: 'worktree removed' },
  'commit.created': { glyph: '●', color: chalk.yellow, label: 'commit' },
  'pushed': { glyph: '↥', color: chalk.yellow, label: 'pushed' },
  'subagent.spawned': { glyph: '⑂', color: chalk.magenta, label: 'sub-agent spawned' },
  'artifact.created': { glyph: '▤', color: chalk.cyan, label: 'artifact' },
  'status.posted': { glyph: '▸', color: chalk.white, label: 'status' },
  'file.edited': { glyph: '·', color: chalk.gray, label: 'file edited' },
};

export function styleForEvent(event: string) {
  return EVENT_STYLE[event] ?? { glyph: '•', color: chalk.white, label: event };
}

/** One rendered activity line: `  <rel>  [host] <glyph label> detail url`. */
export function formatActivityLine(ev: ActivityEvent, opts: { showHost?: boolean } = {}): string {
  const s = styleForEvent(ev.event);
  const host = opts.showHost && ev.host && ev.host !== 'unknown' ? chalk.gray(`[${ev.host}] `) : '';
  const label = s.color(`${s.glyph} ${s.label}`);
  // Status posts are the message; allow a longer snippet than tool-derived detail.
  const detailLimit = ev.event === 'status.posted' ? 100 : 60;
  const detail = ev.detail ? ` ${truncate(ev.detail, detailLimit)}` : '';
  const url = ev.url ? chalk.gray(` ${ev.url}`) : '';
  const agent = ev.event === 'status.posted' && ev.agent ? chalk.gray(` · ${ev.agent}`) : '';
  const when = chalk.gray(relTime(ev.ts).padStart(7));
  return `  ${when}  ${host}${label}${detail}${agent}${url}`;
}

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

/**
 * The activity-log hook (Python), sibling to 10-feed-publish.py. Classifies
 * PreToolUse/PostToolUse payloads into activity events and appends one JSONL
 * line per event to ~/.agents/.history/activity/<sessionId>.jsonl.
 *
 * Matcher-gated to mutating/milestone tools (Bash|Task|ExitPlanMode|Write|
 * Edit|MultiEdit) so read-only tools never pay the hook cost. Fail-open: any
 * error is swallowed so a logging hiccup never blocks a tool call.
 */
export const ACTIVITY_LOG_HOOK_SCRIPT = `#!/usr/bin/env python3
"""Append agent-activity events for \`agents feed\` / \`agents activity\`.

Bound to PreToolUse (ExitPlanMode, Task) and PostToolUse (Bash, Write, Edit,
MultiEdit). One append-only file per session; read-only tools never trigger it
because the manifest matcher excludes them.

Sub-agent gate: when the payload carries \`agent_type\`, this is a Task/Agent
sub-agent -- skip so only the top-level agent logs its own activity.

Fail-open: ANY error is swallowed so a logging hiccup never blocks a tool call.
"""
import os
import re
import sys
import json
import shlex
import socket
from datetime import datetime, timezone

MAX_LOG_BYTES = 5 * 1024 * 1024  # cap a pathological session's log
MILESTONE_EVENTS = {
    "plan.created", "pr.opened", "pr.merged", "worktree.created",
    "worktree.removed", "commit.created", "pushed", "subagent.spawned",
    "artifact.created", "status.posted",
}

# Deliverable file types + locations -- a Write here is a recognizable artifact
# (an HTML plan, a PDF report, a rendered image), not a routine code edit.
ARTIFACT_EXTS = {
    ".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg",
    ".webp", ".mp4", ".mov", ".webm", ".csv", ".xlsx", ".pptx", ".docx",
}
ARTIFACT_DIR_HINTS = ("/tmp/", "/downloads/", "/.agents/artifacts/")


def is_artifact(file_path):
    low = (file_path or "").lower()
    if os.path.splitext(low)[1] in ARTIFACT_EXTS:
        return True
    return any(hint in low for hint in ARTIFACT_DIR_HINTS)


def first_line(text, limit=140):
    for raw in (text or "").splitlines():
        s = raw.strip().lstrip("#").strip()
        if s:
            return s[:limit]
    return ""


def _subcommand(tokens, tool):
    """First non-flag token after \`tool\`, i.e. its subcommand (skips -C <path>,
    -c <cfg>, and other leading flags). None if \`tool\` isn't the invoked command."""
    try:
        i = tokens.index(tool) + 1
    except ValueError:
        return None, []
    while i < len(tokens):
        t = tokens[i]
        if t in ("-C", "-c", "--git-dir", "--work-tree"):
            i += 2  # flag that consumes the next token
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t, tokens[i + 1:]
    return None, []


def classify_bash(command):
    """Return the milestone event for a git/gh command, else None. Tokenizes so a
    path like \`git diff -- src/commit.ts\` is not mistaken for a commit."""
    try:
        tokens = shlex.split(command or "")
    except Exception:
        tokens = (command or "").split()

    verb, rest = _subcommand(tokens, "git")
    if verb == "worktree":
        sub = rest[0] if rest else ""
        if sub == "add":
            return "worktree.created"
        if sub == "remove":
            return "worktree.removed"
    elif verb == "commit":
        return "commit.created"
    elif verb == "push":
        return "pushed"

    verb, rest = _subcommand(tokens, "gh")
    if verb == "pr" and rest:
        if rest[0] == "create":
            return "pr.opened"
        if rest[0] == "merge":
            return "pr.merged"
    return None


def extract_url(tool_response):
    """Pull the first https URL out of a Bash tool response (stdout)."""
    text = ""
    if isinstance(tool_response, dict):
        text = str(tool_response.get("stdout") or tool_response.get("output") or "")
    elif isinstance(tool_response, str):
        text = tool_response
    m = re.search(r"https?://\\S+", text)
    return m.group(0).rstrip(").,") if m else None


def build_event(payload, hook_event):
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {}) or {}
    tool_response = payload.get("tool_response", {})

    event = None
    detail = None
    url = None

    if hook_event == "PreToolUse":
        if tool_name == "ExitPlanMode":
            event = "plan.created"
            detail = first_line(tool_input.get("plan", "")) or "plan presented"
        elif tool_name == "Task":
            event = "subagent.spawned"
            role = tool_input.get("subagent_type") or "agent"
            desc = tool_input.get("description") or tool_input.get("prompt") or ""
            detail = (role + ": " + first_line(desc)).strip(": ").strip()
    elif hook_event == "PostToolUse":
        if tool_name == "Bash":
            event = classify_bash(tool_input.get("command", ""))
            if event:
                detail = first_line(tool_input.get("command", ""))
                url = extract_url(tool_response)
        elif tool_name in ("Write", "Edit", "MultiEdit"):
            fp = tool_input.get("file_path") or tool_input.get("path") or ""
            # A freshly-written deliverable is a milestone; edits and code
            # writes stay routine and collapse to a count.
            if tool_name == "Write" and is_artifact(fp):
                event = "artifact.created"
            else:
                event = "file.edited"
            detail = os.path.basename(fp) if fp else tool_name

    if not event:
        return None, tool_name

    tier = "milestone" if event in MILESTONE_EVENTS else "activity"
    record = {
        "v": 1,
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "tier": tier,
    }
    if detail:
        record["detail"] = detail
    if url:
        record["url"] = url
    record["tool"] = tool_name
    return record, tool_name


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return

    # Sub-agent gate -- only the top-level agent logs.
    if payload.get("agent_type"):
        return

    session_id = payload.get("session_id", "")
    if not session_id:
        return

    hook_event = payload.get("hook_event_name", "")
    record, tool_name = build_event(payload, hook_event)
    if not record:
        return

    safe_session = re.sub(r"[^A-Za-z0-9._-]", "-", session_id) or "unknown"
    home = os.environ.get("HOME") or os.path.expanduser("~")
    activity_dir = os.path.join(home, ".agents", ".history", "activity")
    target = os.path.join(activity_dir, safe_session + ".jsonl")

    # Identity (mirrors 10-feed-publish.py).
    mailbox_id = os.path.basename(
        os.environ.get("AGENTS_MAILBOX_DIR", "").rstrip("/")
    ) or session_id
    hostname = os.environ.get("AGENTS_SYNC_MACHINE_ID") or socket.gethostname()
    host = re.sub(r"[^a-z0-9_-]", "-", hostname.split(".")[0].strip().lower()) or "unknown"

    record["sessionId"] = session_id
    record["mailboxId"] = mailbox_id
    record["host"] = host
    record["runtime"] = os.environ.get("AGENTS_RUNTIME", "headless")
    cwd = payload.get("cwd") or os.environ.get("AGENTS_CWD")
    if cwd:
        record["cwd"] = cwd
    agent = os.environ.get("AGENTS_AGENT_NAME") or "claude"
    record["agent"] = agent

    try:
        os.makedirs(activity_dir, exist_ok=True)
        # Cap growth: once over the size limit, keep only milestones.
        if record["tier"] != "milestone":
            try:
                if os.path.getsize(target) > MAX_LOG_BYTES:
                    return
            except OSError:
                pass
        with open(target, "a") as f:
            f.write(json.dumps(record) + "\\n")
    except Exception:
        pass  # fail open


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail open
`;

/** Hook manifest entries (agents.yaml shape) for the activity-log hook. */
export const ACTIVITY_HOOK_DEFINITIONS: Record<string, Record<string, unknown>> = {
  'activity-log-intent': {
    agents: ['claude'],
    events: ['PreToolUse'],
    matcher: 'ExitPlanMode|Task',
    script: '11-activity-log.py',
    timeout: 5,
  },
  'activity-log-result': {
    agents: ['claude'],
    events: ['PostToolUse'],
    matcher: 'Bash|Write|Edit|MultiEdit',
    script: '11-activity-log.py',
    timeout: 5,
  },
};

/**
 * Install the activity-log hook script into the user hooks dir and add its
 * manifest entries to the user agents.yaml. Mirrors {@link ensureFeedPublishHook}
 * in feed.ts -- idempotent, and never writes the read-only system repo.
 */
export function ensureActivityLogHook(userAgentsDir: string = getUserAgentsDir()): { installed: boolean; error?: string } {
  try {
    const hooksDir = path.join(userAgentsDir, 'hooks');
    const scriptPath = path.join(hooksDir, '11-activity-log.py');

    fs.mkdirSync(hooksDir, { recursive: true });
    let installed = false;
    if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf-8') !== ACTIVITY_LOG_HOOK_SCRIPT) {
      const tmpScript = `${scriptPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpScript, ACTIVITY_LOG_HOOK_SCRIPT, { mode: 0o755 });
      fs.renameSync(tmpScript, scriptPath);
      installed = true;
    }

    const agentsYamlPath = path.join(userAgentsDir, 'agents.yaml');
    const yamlDoc = fs.existsSync(agentsYamlPath)
      ? yaml.parseDocument(fs.readFileSync(agentsYamlPath, 'utf-8'))
      : new yaml.Document({});
    if (yamlDoc.errors.length > 0) {
      throw new Error(`Cannot install activity hook: ${agentsYamlPath} is invalid YAML`);
    }
    for (const [name, definition] of Object.entries(ACTIVITY_HOOK_DEFINITIONS)) {
      if (!yamlDoc.getIn(['hooks', name])) {
        yamlDoc.setIn(['hooks', name], definition);
        installed = true;
      }
    }
    if (installed) {
      const tmpYaml = `${agentsYamlPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpYaml, String(yamlDoc));
      fs.renameSync(tmpYaml, agentsYamlPath);
    }

    return { installed };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}
