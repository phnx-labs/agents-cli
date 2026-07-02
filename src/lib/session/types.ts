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
  mediaType?: string;
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
  project?: string;
  cwd?: string;
  filePath: string;
  gitBranch?: string;
  messageCount?: number;
  tokenCount?: number;
  /** Total USD cost, computed at scan time from per-model token usage (issue #323). */
  costUsd?: number;
  /** Wall-clock duration in ms (lastTs − firstTs), persisted at scan time. */
  durationMs?: number;
  version?: string;
  account?: string;
  topic?: string;
  /** Custom name the user gave the session (e.g. Claude Code /rename). */
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
