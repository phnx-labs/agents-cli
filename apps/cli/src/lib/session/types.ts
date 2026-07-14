/**
 * Session data model.
 *
 * Normalized types that unify the different session storage formats used by
 * Claude (JSONL), Codex (JSONL events), Gemini (single JSON), and OpenCode.
 * Everything in the session pipeline -- discovery, parsing, rendering --
 * speaks these types.
 */

/** Agents that store session data on disk and can be discovered by `agents sessions`. */
export type SessionAgentId = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'opencode' | 'openclaw' | 'rush' | 'hermes' | 'grok' | 'kimi' | 'droid';

/** All agents with session discovery support, in display order. */
export const SESSION_AGENTS: SessionAgentId[] = ['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'openclaw', 'rush', 'hermes', 'grok', 'kimi', 'droid'];

/** A single normalized event within a session (message, tool call, thinking, etc.). */
export interface SessionEvent {
  type: 'message' | 'tool_use' | 'tool_result' | 'thinking' | 'error' | 'init' | 'result' | 'usage' | 'attachment';
  agent: SessionAgentId;
  timestamp: string;
  role?: 'user' | 'assistant';
  content?: string;
  tool?: string;
  args?: Record<string, any>;
  path?: string;
  command?: string;
  success?: boolean;
  output?: string;
  /** Internal: marks tool_use events from local commands */
  _local?: boolean;
  // Fields for usage events (type === 'usage')
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  // Fields for attachment events (type === 'attachment')
  name?: string;
  mediaType?: string;
  sizeBytes?: number;
}

/** A displayable file attachment discovered in a session transcript. */
export interface SessionAttachment {
  path?: string;
  name?: string;
  mediaType: string;
  sizeBytes?: number;
}

/** Metadata attached when a session was spawned by `agents teams`. */
export interface TeamOrigin {
  /** Teammate name if set, otherwise first 8 chars of the agent UUID. */
  handle?: string;
  /** Agent mode: 'plan', 'edit', 'auto', or 'skip' ('full' accepted as legacy alias for 'skip'). */
  mode?: string;
}

/** Lightweight metadata for a discovered session, used in listings and pickers. */
export interface SessionMeta {
  id: string;
  shortId: string;
  agent: SessionAgentId;
  timestamp: string;
  /**
   * Last-activity time (ISO): the last message timestamp when a parser computed
   * it, else file mtime, else `timestamp`. This is the recency signal the
   * listing sorts and labels by; `timestamp` stays the creation time.
   */
  lastActivity?: string;
  project?: string;
  cwd?: string;
  filePath: string;
  gitBranch?: string;
  messageCount?: number;
  tokenCount?: number;
  /** Real generated (output) tokens — excludes cache-read/-write context (issue: `agents output`). */
  outputTokens?: number;
  /** Total USD cost, computed at scan time from per-model token usage (issue #323). */
  costUsd?: number;
  /** Wall-clock duration in ms (lastTs − firstTs), persisted at scan time. */
  durationMs?: number;
  version?: string;
  account?: string;
  topic?: string;
  /**
   * The session's human-readable name — one field, several sources with a plain
   * priority: an agent-generated title / Claude `/rename` wins; else the launch
   * handle seeded from `agents run --name <slug>` (interactive, headless, remote
   * host, or a teams teammate); else it stays unset and the listing falls back to
   * `topic`. Searchable via `agents sessions <label>`. (Before v10 the launch
   * handle lived in a separate immutable `name` column; `--name` now just seeds
   * this label.)
   */
  label?: string;
  /** Set when this session was spawned by `agents teams`. */
  teamOrigin?: TeamOrigin;
  /** Durable state signals extracted at scan time by the session-state engine. */
  /** PR URL, if the session opened one (`gh pr create`). */
  prUrl?: string;
  /** PR number parsed from prUrl, for compact display. */
  prNumber?: number;
  /** Worktree slug when cwd is under `.agents/worktrees/<slug>/`. */
  worktreeSlug?: string;
  /** Tracker ticket ref (e.g. RUSH-1234) from the prompt or branch. */
  ticketId?: string;
  /**
   * Tracker refs the session CREATED during its run — Linear `create_issue` MCP
   * calls or `gh issue create` shell commands — read from the tool result. Distinct
   * from `ticketId` (the injected/worked-on ticket from the prompt or branch).
   */
  createdTickets?: string[];
  /**
   * Team name this session SPAWNED via `agents teams create/add`. The inverse of
   * `isTeamOrigin` (which marks sessions spawned BY a team).
   */
  spawnedTeam?: string;
  /**
   * The plan markdown from the LAST `ExitPlanMode` tool call in the transcript
   * (Claude sessions only), captured at scan time. Present whenever the session
   * ever entered plan-review; consumers can pair it with a live
   * `awaitingReason === 'plan_review'` to decide whether it is still pending.
   * Fills the gap that forced the Factory extension to re-read raw JSONL to
   * recover the plan text — the CLI now carries it on the metadata row.
   */
  plan?: string;
  /**
   * True when the session was spawned programmatically (SDK entrypoint) rather
   * than by a human at the Claude CLI. Captured at scan time from the JSONL
   * `entrypoint` field ('sdk-cli' for team spawns, 'cli' for real sessions).
   */
  isTeamOrigin?: boolean;
  /**
   * The machine (normalized hostname) this session's transcript originated on:
   * the local machine for live-home sessions, or the origin machine parsed from
   * the cross-machine mirror path (backups/<agent>/<machine>/…, see
   * sync/agents.ts). Populated by discoverSessions for the listing/picker;
   * undefined for sessions obtained outside that path.
   */
  machine?: string;
  /**
   * True only for rows pulled from another machine over the live cross-machine
   * fan-out (`remote-list.ts`) — their transcript is on that peer's disk, so
   * reading/resuming has to hop back over SSH. Distinct from `machine`, which is
   * also set on locally-readable synced mirrors: a mirror is machine-tagged but
   * its `filePath` is a local path, so it must NOT be treated as remote. Set by
   * `parseRemoteList`; transient (never persisted, stripped from --json).
   */
  _remote?: boolean;
  /** Terms that matched the current search query */
  _matchedTerms?: string[];
  /** BM25 relevance score from the most recent content-index search */
  _bm25Score?: number;
}

/** Output format for rendering a session's content. */
export type ViewMode = 'summary' | 'markdown' | 'json';

/** A file created or modified during a session, discovered from tool_use events. */
export interface SessionArtifact {
  path: string;
  tool: string;
  timestamp: string;
  exists: boolean;
  sizeBytes?: number;
  sessionId: string;
}
