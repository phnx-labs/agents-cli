// Pure utility functions that can be tested without VS Code dependencies

export const CLAUDE_TITLE = 'CC';
export const CODEX_TITLE = 'CX';
export const GEMINI_TITLE = 'GX';
export const OPENCODE_TITLE = 'OC';
export const CURSOR_TITLE = 'CR';
export const SHELL_TITLE = 'SH';
export const ANTIGRAVITY_TITLE = 'AG';
export const GROK_TITLE = 'GK';
export const KIMI_TITLE = 'KM';
export const DROID_TITLE = 'DR';
export const LABEL_MAX_WORDS = 5;

export const KNOWN_PREFIXES = [CLAUDE_TITLE, CODEX_TITLE, GEMINI_TITLE, OPENCODE_TITLE, CURSOR_TITLE, SHELL_TITLE, ANTIGRAVITY_TITLE, GROK_TITLE, KIMI_TITLE, DROID_TITLE];

// Agent type for session operations
export type SessionAgentType = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'antigravity' | 'grok' | 'kimi' | 'droid';

// Bidirectional prefix mappings (case-insensitive)
// Canonical: CC, CX, GX, OC, CR, SH (used in terminal names, utils.ts)
// Config: cl, cx, gm, oc, cr, sh (used in agents.ts agentConfig.prefix)
const PREFIX_MAPPINGS: Array<{ canonical: string; config: string; agentType: SessionAgentType | null }> = [
  { canonical: CLAUDE_TITLE, config: 'cl', agentType: 'claude' },
  { canonical: CODEX_TITLE, config: 'cx', agentType: 'codex' },
  { canonical: GEMINI_TITLE, config: 'gm', agentType: 'gemini' },
  { canonical: OPENCODE_TITLE, config: 'oc', agentType: 'opencode' },
  { canonical: CURSOR_TITLE, config: 'cr', agentType: 'cursor' },
  { canonical: SHELL_TITLE, config: 'sh', agentType: null },
  { canonical: ANTIGRAVITY_TITLE, config: 'ag', agentType: 'antigravity' },
  { canonical: GROK_TITLE, config: 'gk', agentType: 'grok' },
  { canonical: KIMI_TITLE, config: 'km', agentType: 'kimi' },
  { canonical: DROID_TITLE, config: 'dr', agentType: 'droid' }
];

// Convert canonical prefix (CC) to config prefix (cl) - case insensitive
export function canonicalToConfigPrefix(input: string | null): string | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  const mapping = PREFIX_MAPPINGS.find(m => m.canonical.toLowerCase() === lower);
  return mapping?.config || null;
}

// Convert config prefix (cl) to canonical prefix (CC) - case insensitive
export function configToCanonicalPrefix(input: string | null): string | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  const mapping = PREFIX_MAPPINGS.find(m => m.config.toLowerCase() === lower);
  return mapping?.canonical || null;
}

// Map from prefix to SessionAgentType - accepts either format, case insensitive
export function prefixToAgentType(input: string | null): SessionAgentType | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  const mapping = PREFIX_MAPPINGS.find(
    m => m.canonical.toLowerCase() === lower || m.config.toLowerCase() === lower
  );
  return mapping?.agentType || null;
}

// Mapping of acceptable terminal base names to canonical prefixes
const NAME_TO_PREFIX: Record<string, string> = {
  [CLAUDE_TITLE]: CLAUDE_TITLE,
  'CL': CLAUDE_TITLE,
  'CLAUDE': CLAUDE_TITLE,
  'Claude': CLAUDE_TITLE,
  'claude': CLAUDE_TITLE,
  [CODEX_TITLE]: CODEX_TITLE,
  'CODEX': CODEX_TITLE,
  'Codex': CODEX_TITLE,
  'codex': CODEX_TITLE,
  [GEMINI_TITLE]: GEMINI_TITLE,
  'GEMINI': GEMINI_TITLE,
  'Gemini': GEMINI_TITLE,
  'gemini': GEMINI_TITLE,
  [OPENCODE_TITLE]: OPENCODE_TITLE,
  'OPENCODE': OPENCODE_TITLE,
  'OpenCode': OPENCODE_TITLE,
  'opencode': OPENCODE_TITLE,
  [CURSOR_TITLE]: CURSOR_TITLE,
  'CURSOR': CURSOR_TITLE,
  'Cursor': CURSOR_TITLE,
  'cursor': CURSOR_TITLE,
  [SHELL_TITLE]: SHELL_TITLE,
  'SHELL': SHELL_TITLE,
  'Shell': SHELL_TITLE,
  'shell': SHELL_TITLE,
  [ANTIGRAVITY_TITLE]: ANTIGRAVITY_TITLE,
  'ANTIGRAVITY': ANTIGRAVITY_TITLE,
  'Antigravity': ANTIGRAVITY_TITLE,
  'antigravity': ANTIGRAVITY_TITLE,
  [GROK_TITLE]: GROK_TITLE,
  'GROK': GROK_TITLE,
  'Grok': GROK_TITLE,
  'grok': GROK_TITLE,
  [KIMI_TITLE]: KIMI_TITLE,
  'KIMI': KIMI_TITLE,
  'Kimi': KIMI_TITLE,
  'kimi': KIMI_TITLE,
  [DROID_TITLE]: DROID_TITLE,
  'DROID': DROID_TITLE,
  'Droid': DROID_TITLE,
  'droid': DROID_TITLE
};

export interface DisplayPreferences {
  showFullAgentNames: boolean;
  showLabelsInTitles: boolean;
  showSessionIdInTitles: boolean;
  labelReplacesTitle: boolean;
  showLabelOnlyOnFocus: boolean;
}

export interface ParsedTerminalName {
  isAgent: boolean;
  prefix: string | null;
  label: string | null;
  sessionChunk: string | null;
}

/**
 * Parse a terminal name to identify if it's an agent terminal.
 * Strict matching: only matches exact prefixes or "PREFIX - label" format.
 */
export function parseTerminalName(name: string): ParsedTerminalName {
  const trimmed = name.trim();

  // Support both short codes (CC) and full names (Claude)
  for (const [candidate, canonicalPrefix] of Object.entries(NAME_TO_PREFIX)) {
    // Exact match
    if (trimmed === candidate) {
      return { isAgent: true, prefix: canonicalPrefix, label: null, sessionChunk: null };
    }
    // Match with label
    if (trimmed.startsWith(`${candidate} - `)) {
      const label = trimmed.substring(candidate.length + 3).trim();
      if (label) {
        return { isAgent: true, prefix: canonicalPrefix, label, sessionChunk: null };
      }
    }
    // Match with session chunk
    if (trimmed.startsWith(`${candidate} `)) {
      const remainder = trimmed.substring(candidate.length + 1).trim();
      if (!remainder) continue;
      const separatorIndex = remainder.indexOf(' - ');
      const chunk = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex).trim();
      if (chunk && chunk.length === 8) {
        if (separatorIndex === -1) {
          return { isAgent: true, prefix: canonicalPrefix, label: null, sessionChunk: chunk };
        }
        const label = remainder.slice(separatorIndex + 3).trim();
        if (label) {
          return { isAgent: true, prefix: canonicalPrefix, label, sessionChunk: chunk };
        }
      }
    }
  }

  return { isAgent: false, prefix: null, label: null, sessionChunk: null };
}

/**
 * Sanitize user input for terminal labels.
 * Removes quotes, limits to max words.
 */
export function sanitizeLabel(raw: string): string {
  const stripped = raw.replace(/["'`]/g, '').trim();
  if (!stripped) {
    return '';
  }
  const words = stripped.split(/\s+/).slice(0, LABEL_MAX_WORDS);
  return words.join(' ').trim();
}

/**
 * Get the expanded human-readable name for an agent prefix.
 */
export function getExpandedAgentName(prefix: string): string {
  // Map both title (CC) and prefix (cl) to expanded names
  const expandedNames: Record<string, string> = {
    [CLAUDE_TITLE]: 'Claude',
    [CODEX_TITLE]: 'Codex',
    [GEMINI_TITLE]: 'Gemini',
    [OPENCODE_TITLE]: 'OpenCode',
    [CURSOR_TITLE]: 'Cursor',
    [SHELL_TITLE]: 'Shell',
    [ANTIGRAVITY_TITLE]: 'Antigravity',
    [GROK_TITLE]: 'Grok',
    [KIMI_TITLE]: 'Kimi',
    [DROID_TITLE]: 'Droid',
    // Also map lowercase prefixes from agents.ts
    'cl': 'Claude',
    'cx': 'Codex',
    'gm': 'Gemini',
    'oc': 'OpenCode',
    'cr': 'Cursor',
    'sh': 'Shell',
    'ag': 'Antigravity',
    'gk': 'Grok',
    'km': 'Kimi',
    'dr': 'Droid',
    // Allow already-expanded names to pass through
    'claude': 'Claude',
    'codex': 'Codex',
    'gemini': 'Gemini',
    'opencode': 'OpenCode',
    'cursor': 'Cursor',
    'shell': 'Shell',
    'antigravity': 'Antigravity',
    'grok': 'Grok',
    'kimi': 'Kimi',
    'droid': 'Droid'
  };
  return expandedNames[prefix] || prefix;
}

/**
 * Get the first 8 characters of a UUID session ID.
 */
export function getSessionChunk(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const chunk = sessionId.split('-')[0];
  return chunk && chunk.length === 8 ? chunk : null;
}

/**
 * Extract a Linear-style ticket ID (e.g. RUSH-545, ENG-42) from text.
 * Matches the first occurrence of `[A-Z][A-Z0-9]*-\d+` surrounded by word boundaries.
 */
export function extractLinearTicketId(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\b[A-Z][A-Z0-9]*-\d+\b/);
  return match ? match[0] : null;
}

/**
 * Extract the first N words from a string for auto-label generation.
 * Used for status bar display when no user label is set.
 */
export function extractFirstNWords(text: string | undefined, n: number = 5): string | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  const words = cleaned.split(' ').slice(0, n);
  if (words.length === 0) return null;
  const result = words.join(' ');
  // Add ellipsis if truncated
  if (cleaned.split(' ').length > n) {
    return result + '...';
  }
  return result;
}

// Bidirectional icon <-> prefix mapping
const ICON_TO_PREFIX: Record<string, string> = {
  'claude.png': CLAUDE_TITLE,
  'chatgpt.png': CODEX_TITLE,
  'gemini.png': GEMINI_TITLE,
  'opencode.png': OPENCODE_TITLE,
  'cursor.png': CURSOR_TITLE,
  'agents.png': SHELL_TITLE,
  'antigravity.png': ANTIGRAVITY_TITLE,
  'grok.png': GROK_TITLE,
  'kimi.png': KIMI_TITLE,
  'droid.png': DROID_TITLE
};

const PREFIX_TO_ICON: Record<string, string> = {
  [CLAUDE_TITLE]: 'claude.png',
  [CODEX_TITLE]: 'chatgpt.png',
  [GEMINI_TITLE]: 'gemini.png',
  [OPENCODE_TITLE]: 'opencode.png',
  [CURSOR_TITLE]: 'cursor.png',
  [SHELL_TITLE]: 'agents.png',
  [ANTIGRAVITY_TITLE]: 'antigravity.png',
  [GROK_TITLE]: 'grok.png',
  [KIMI_TITLE]: 'kimi.png',
  [DROID_TITLE]: 'droid.png'
};

/**
 * Get the icon filename for an agent prefix.
 */
export function getIconFilename(prefix: string): string | null {
  return PREFIX_TO_ICON[prefix] || null;
}

/**
 * Get the agent prefix from an icon filename.
 * Reverse lookup for icon-based identification.
 */
export function getPrefixFromIconFilename(iconFilename: string): string | null {
  return ICON_TO_PREFIX[iconFilename] || null;
}

export interface TerminalTitleOptions {
  display?: DisplayPreferences;
  label?: string | null;
  sessionChunk?: string | null;
  isFocused?: boolean;  // When false and showLabelOnlyOnFocus=true, hide label
}

/**
 * Build the terminal tab title based on display preferences.
 * Canonical prefix should be one of the KNOWN_PREFIXES.
 * When isFocused=false and showLabelOnlyOnFocus=true, label is hidden.
 */
export function formatTerminalTitle(prefix: string, options?: TerminalTitleOptions): string {
  let display = options?.display;

  // If terminal is not focused and showLabelOnlyOnFocus is enabled, hide the label
  if (options?.isFocused === false && display?.showLabelOnlyOnFocus) {
    display = { ...display, showLabelsInTitles: false };
  }

  const base = display?.showFullAgentNames ? getExpandedAgentName(prefix) : prefix;
  const sessionChunk = display?.showSessionIdInTitles ? options?.sessionChunk?.trim() : null;

  const label = options?.label?.trim()?.replace(/<[^>]*>/g, '').trim() || null;
  if (sessionChunk) {
    if (display?.showLabelsInTitles && label) {
      return `${base} ${sessionChunk} - ${label}`;
    }
    return `${base} ${sessionChunk}`;
  }

  if (!display?.showLabelsInTitles || !label) {
    return base;
  }

  // Check labelReplacesTitle setting
  if (display?.labelReplacesTitle) {
    return label;  // Replace mode: only the label
  }

  // Append mode: "Claude - auth feature"
  return `${base} - ${label}`;
}

/** Max characters of the session label shown in a tmux pane border before we ellipsize. */
export const PANE_BORDER_LABEL_MAX = 48;

/**
 * Build the text shown inside a tmux pane border (the ` #{pane_index}: <text> `
 * label). Mirrors the VS Code tab: bare agent code (e.g. "CC") until a session
 * label resolves, then "CC - <topic>". The label arrives asynchronously (the
 * auto-label poller / focus fetch), so this is re-run live whenever it changes.
 *
 * The result is embedded in a tmux `pane-border-format`, which re-expands
 * `#{...}` / `#[...]` sequences and treats a lone `#` as an escape — so any `#`
 * in the label is doubled to render literally, and newlines are flattened.
 */
export function paneBorderText(
  name: string,
  label?: string | null,
  maxLabelLen: number = PANE_BORDER_LABEL_MAX
): string {
  const clean = (label ?? '')
    .replace(/<[^>]*>/g, '')      // drop any stray markup, matching formatTerminalTitle
    .replace(/[\r\n]+/g, ' ')     // flatten newlines — a border is a single line
    .replace(/\s+/g, ' ')
    .trim();
  // Double `#` so tmux renders it literally rather than as a format escape.
  // Applied on every return path so `name` is neutralized uniformly, whatever
  // it holds (agent codes have no `#` today, but don't rely on that here).
  const escapeHash = (s: string): string => s.replace(/#/g, '##');
  if (!clean) return escapeHash(name);
  const clipped =
    clean.length > maxLabelLen ? `${clean.slice(0, maxLabelLen - 1).trimEnd()}…` : clean;
  // Escape last so the ellipsis/slice math above operates on the visible text.
  return escapeHash(`${name} - ${clipped}`);
}

export interface TerminalDisplayInfo {
  isAgent: boolean;
  prefix: string | null;
  label: string | null;
  expandedName: string | null;
  statusBarText: string | null;
  iconFilename: string | null;
  sessionChunk: string | null;
}

/**
 * Options for terminal identification.
 * Multiple inputs allow fallback strategies when name parsing fails.
 */
export interface TerminalIdentificationOptions {
  /** Terminal name (required) */
  name: string;
  /** Icon filename (e.g., "claude.png") - extracted from terminal.creationOptions.iconPath */
  iconFilename?: string | null;
  /** Terminal ID from AGENT_TERMINAL_ID env var (e.g., "CC-1735824000000-1") */
  terminalId?: string | null;
  /** Session ID from AGENT_SESSION_ID env var (UUID) */
  sessionId?: string | null;
  /** Pinned agent version from AGENT_VERSION env var (e.g., "2.1.113") */
  version?: string | null;
}

/**
 * Get complete display info for a terminal.
 *
 * SINGLE SOURCE OF TRUTH for identifying agent terminals.
 * Uses multiple fallback strategies in priority order:
 *
  * 1. Parse name - handles "CC", "Claude", "CC - label", "Claude - label"
 * 2. Extract prefix from AGENT_TERMINAL_ID env var
 * 3. Reverse-lookup prefix from icon filename
 *
 * When name parsing fails but we identify via env/icon, the terminal name
 * is treated as the label (e.g., name="auth feature" becomes the label).
 */
export function getTerminalDisplayInfo(options: TerminalIdentificationOptions): TerminalDisplayInfo {
  const { name, iconFilename, terminalId } = options;

  // Strategy 1: Parse name (handles "CC", "Claude", "CC - label", etc.)
  const parsed = parseTerminalName(name);
  if (parsed.isAgent && parsed.prefix) {
    return buildDisplayInfo(parsed.prefix, parsed.label, parsed.sessionChunk);
  }

  // Strategy 2: Extract prefix from AGENT_TERMINAL_ID env var
  if (terminalId) {
    const prefix = getPrefixFromTerminalId(terminalId);
    if (prefix && KNOWN_PREFIXES.includes(prefix)) {
      return buildDisplayInfo(prefix, name.trim() || null, null);
    }
  }

  // Strategy 3: Reverse-lookup from icon filename
  if (iconFilename) {
    const prefix = getPrefixFromIconFilename(iconFilename);
    if (prefix) {
      return buildDisplayInfo(prefix, name.trim() || null, null);
    }
  }

  // Not an agent terminal
  return {
    isAgent: false,
    prefix: null,
    label: null,
    expandedName: null,
    statusBarText: null,
    iconFilename: null,
    sessionChunk: null
  };
}

function buildDisplayInfo(prefix: string, label: string | null, sessionChunk: string | null): TerminalDisplayInfo {
  const expandedName = getExpandedAgentName(prefix);
  const statusBarText = label
    ? `${expandedName} - ${label}`
    : expandedName;

  return {
    isAgent: true,
    prefix,
    label,
    expandedName,
    statusBarText,
    iconFilename: getIconFilename(prefix),
    sessionChunk
  };
}

/**
 * Extract agent prefix from a terminal ID (e.g., "CC-1735824000000-1" -> "CC")
 */
export function getPrefixFromTerminalId(terminalId: string): string | null {
  const prefix = terminalId.split('-')[0];
  // Backward compatibility: accept old 'CL' prefix
  if (prefix === 'CL') {
    return CLAUDE_TITLE;
  }
  // We don't strictly check KNOWN_PREFIXES here to allow custom agents 
  // which might use their name as prefix.
  return prefix || null;
}

/**
 * Find a terminal name that matches a tab label.
 * Returns the matching name from the list, or null if not found.
 * Used for matching terminal tabs to terminal instances.
 */
export function findTerminalNameByTabLabel(
  terminalNames: string[],
  tabLabel: string
): string | null {
  return terminalNames.find(name => name === tabLabel) ?? null;
}

export interface McpServerConfig {
  type: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Merge a new MCP server into an existing config.
 * Preserves existing servers while adding/updating the specified one.
 */
export function mergeMcpConfig(
  existing: McpConfig | null,
  serverName: string,
  serverConfig: McpServerConfig
): McpConfig {
  const config: McpConfig = existing ? { ...existing } : {};
  config.mcpServers = { ...(config.mcpServers || {}), [serverName]: serverConfig };
  return config;
}

/**
 * Create the swarm MCP server config for a given cli-ts path.
 */
export function createSwarmServerConfig(cliTsIndexPath: string): McpServerConfig {
  return {
    type: 'stdio',
    command: 'node',
    args: [cliTsIndexPath],
    env: {}
  };
}

// === PROMPT UTILITIES ===

export interface PromptEntryLike {
  id: string;
  isFavorite: boolean;
  accessedAt: number;
}

/**
 * Sort prompt entries: favorites first, then by accessedAt (most recently used first).
 */
export function sortPrompts<T extends PromptEntryLike>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    // Favorites first
    if (a.isFavorite !== b.isFavorite) {
      return a.isFavorite ? -1 : 1;
    }
    // Then by accessedAt (most recently used first)
    return b.accessedAt - a.accessedAt;
  });
}

/**
 * Check if a prompt ID is a built-in prompt (not user-created).
 */
export function isBuiltInPromptId(id: string): boolean {
  return id.startsWith('builtin-');
}

/**
 * Truncate text with ellipsis for display.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Format a timestamp as relative time (e.g., "5m ago", "2h ago").
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
