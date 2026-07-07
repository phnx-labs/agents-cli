// Session pre-warming - pure functions and types
// VS Code integration in prewarm.vscode.ts

export type PrewarmAgentType = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';

/** Configuration for pre-warming per agent type */
export interface PrewarmConfig {
  agentType: PrewarmAgentType;
  command: string;              // CLI command (e.g., 'claude', 'codex', 'gemini')
  statusCommand: string;        // Command to get session info (e.g., '/status', '/stats')
  sessionIdPattern: RegExp;     // Pattern to extract session ID from output
  exitSequence: string[];       // Key sequences to cleanly exit
  resumeCommand: (sessionId: string) => string;
}

/** A pre-warmed session ready for hand-off */
export interface PrewarmedSession {
  agentType: PrewarmAgentType;
  sessionId: string;
  createdAt: number;
  workingDirectory: string;
}

/** Session pool state */
export interface SessionPoolState {
  available: PrewarmedSession[];
  pending: number;              // Number currently being created
}

/** Terminal-to-session mapping for crash recovery */
export interface TerminalSessionMapping {
  terminalId: string;           // AGENT_TERMINAL_ID
  sessionId: string;            // CLI session ID
  agentType: PrewarmAgentType;
  createdAt: number;
  workingDirectory: string;
}

// Pre-warm configurations per agent
export const PREWARM_CONFIGS: Record<PrewarmAgentType, PrewarmConfig> = {
  claude: {
    agentType: 'claude',
    command: 'claude',
    statusCommand: '/status',
    // Matches: "Session ID: 01J9..."/"Session: 01J9..."
    sessionIdPattern: /Session(?:\s+ID)?:\s*([a-zA-Z0-9_-]+)/i,
    exitSequence: ['\x1b', '\x03', '\x03'],  // Esc, Ctrl+C, Ctrl+C (need Esc first for Claude)
    resumeCommand: (id) => `claude -r ${id}`
  },
  codex: {
    agentType: 'codex',
    command: 'codex',
    statusCommand: '/status',
    // Matches: "Session: 01J9..." or "Session ID: 01J9..."
    sessionIdPattern: /Session(?:\s+ID)?:\s*([a-zA-Z0-9_-]+)/i,
    exitSequence: ['\x03', '\x03'],  // Ctrl+C twice
    resumeCommand: (id) => `codex resume ${id}`
  },
  gemini: {
    agentType: 'gemini',
    command: 'gemini',
    statusCommand: '/stats',
    // Matches session ID pattern
    sessionIdPattern: /Session(?:\s+ID)?:\s*([a-zA-Z0-9_-]+)/i,
    exitSequence: ['\x03', '\x03'],  // Ctrl+C twice
    resumeCommand: (id) => `gemini --resume ${id}`
  },
  cursor: {
    agentType: 'cursor',
    command: 'cursor-agent',
    statusCommand: '/status',
    // Matches session ID pattern
    sessionIdPattern: /Session(?:\s+ID)?:\s*([a-zA-Z0-9_-]+)/i,
    exitSequence: ['\x03', '\x03'],  // Ctrl+C twice
    resumeCommand: (id) => `cursor-agent --resume=${id}`
  },
  opencode: {
    agentType: 'opencode',
    command: 'opencode',
    statusCommand: '',  // OpenCode doesn't have /status - session ID tracked via session list
    // Matches OpenCode session ID format: ses_xxx
    sessionIdPattern: /ses_[a-zA-Z0-9]+/i,
    exitSequence: ['\x03', '\x03'],  // Ctrl+C twice
    resumeCommand: (id) => `opencode -s ${id}`
  }
};

// Default pool size per agent type
export const DEFAULT_POOL_SIZE = 3;

/**
 * Parse session ID from CLI /status or /stats output
 */
export function parseSessionId(output: string, config: PrewarmConfig): string | null {
  const match = output.match(config.sessionIdPattern);
  return match ? match[1] : null;
}

/**
 * Check if output indicates CLI is ready for input
 * Looks for common prompt indicators
 */
export function isCliReady(output: string, agentType: PrewarmAgentType): boolean {
  // Common patterns that indicate CLI is ready:
  // - ">" prompt
  // - "Welcome" message followed by prompt area
  // - Specific ready indicators per CLI
  const readyPatterns: Record<PrewarmAgentType, RegExp[]> = {
    claude: [
      />\s*$/,                    // Prompt ready
      /Welcome.*\n.*>/s,          // Welcome message + prompt
      /Claude Code v[\d.]+/,      // Version banner indicates startup
      /Try "/,                    // "Try ..." suggestion indicates ready
    ],
    codex: [
      />\s*$/,
      /OpenAI Codex.*\n.*>/s,
      /Context window:/,          // Status area indicates ready
      /sandbox/i,                 // Sandbox mode indicator
    ],
    gemini: [
      />\s*$/,
      /Gemini.*\n.*>/s,
      /gemini/i,                  // Any gemini text
    ],
    cursor: [
      />\s*$/,
      /cursor/i,                  // Any cursor text
      /"type":\s*"result"/,       // JSON result output
    ],
    opencode: [
      />\s*$/,
      /opencode/i,                // Any opencode text
      /Commands:/,                // Help text indicates ready
    ]
  };

  const ready = readyPatterns[agentType].some(pattern => pattern.test(output));
  if (ready) {
    console.log(`[PREWARM] isCliReady(${agentType}): true`);
  }
  return ready;
}

/**
 * Calculate how many sessions need to be created to reach target pool size
 */
export function needsReplenishment(pool: SessionPoolState, targetSize: number): number {
  const current = pool.available.length + pool.pending;
  return Math.max(0, targetSize - current);
}

/**
 * Select best session from pool for given working directory
 * Prefers same directory, then oldest session
 */
export function selectBestSession(
  available: PrewarmedSession[],
  targetCwd: string
): PrewarmedSession | null {
  if (available.length === 0) return null;

  // First try to find one with matching cwd
  const sameCwd = available.find(s => s.workingDirectory === targetCwd);
  if (sameCwd) return sameCwd;

  // Otherwise return oldest (FIFO)
  return available.reduce((oldest, current) =>
    current.createdAt < oldest.createdAt ? current : oldest
  );
}

/**
 * Build resume command for a pre-warmed session
 */
export function buildResumeCommand(session: PrewarmedSession): string {
  const config = PREWARM_CONFIGS[session.agentType];
  return config.resumeCommand(session.sessionId);
}

/**
 * Build a resume command pinned to a specific installed agent version when one
 * is known. This is required for multi-profile setups where a session only
 * exists inside one version's home directory.
 */
export function buildVersionedResumeCommand(
  agentType: PrewarmAgentType,
  sessionId: string,
  version?: string,
): string {
  const config = PREWARM_CONFIGS[agentType];
  const baseCmd = config.resumeCommand(sessionId);
  if (!version) return baseCmd;
  const cmdName = config.command;
  const prefix = new RegExp(`^${cmdName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return baseCmd.replace(prefix, `${cmdName}@${version}`);
}

/**
 * Get all supported agent types
 */
export function getSupportedAgentTypes(): PrewarmAgentType[] {
  return ['claude', 'codex', 'gemini', 'cursor'];
}

/**
 * Check if an agent type supports pre-warming
 */
export function supportsPrewarming(agentType: string): agentType is PrewarmAgentType {
  return agentType === 'claude' || agentType === 'codex' || agentType === 'gemini' || agentType === 'cursor' || agentType === 'opencode';
}

// === Blocking Prompt Detection ===

export type BlockedReason = 'trust_prompt' | 'auth_required' | 'rate_limit' | 'unknown_prompt';
export type FailedReason = 'timeout' | 'cli_error' | 'parse_error' | 'cli_not_found';

export interface PrewarmResult {
  status: 'success' | 'blocked' | 'failed';
  sessionId?: string;
  blockedReason?: BlockedReason;
  failedReason?: FailedReason;
  rawOutput?: string;
}

const BLOCKING_PROMPTS: Record<BlockedReason, RegExp[]> = {
  trust_prompt: [
    /Do you trust the files in this folder/i,
    /Trust the files in this folder/i,
  ],
  auth_required: [
    /Please log in/i,
    /Authentication required/i,
    /API key not found/i,
    /Not authenticated/i,
    /Sign in to continue/i,
  ],
  rate_limit: [
    /Rate limit exceeded/i,
    /Too many requests/i,
    /Please try again later/i,
  ],
  unknown_prompt: [], // Fallback, not matched directly
};

/**
 * Detect if output contains a blocking prompt
 */
export function detectBlockingPrompt(output: string): BlockedReason | null {
  for (const [reason, patterns] of Object.entries(BLOCKING_PROMPTS)) {
    if (reason === 'unknown_prompt') continue;
    if (patterns.some(p => p.test(output))) {
      return reason as BlockedReason;
    }
  }
  return null;
}

/**
 * Strip ANSI escape codes from text
 */
export function stripAnsi(text: string): string {
  // Matches all ANSI escape sequences including:
  // - CSI sequences: \x1b[ ... (letter)
  // - OSC sequences: \x1b] ... \x07 or \x1b] ... \x1b\\
  // - Simple escapes: \x1b followed by single char
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')  // CSI sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')      // OSC sequences (BEL terminated)
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')    // OSC sequences (ST terminated)
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS, SOS, PM, APC sequences
    .replace(/\x1b[@-Z\\-_]/g, '');          // Single character escapes
}

/**
 * UUID pattern for session IDs (UUIDv7 format: 019ba357-61b0-7e51-afdd-cd43c0e32253)
 */
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Multiple patterns to try for session ID extraction
 */
export const SESSION_ID_PATTERNS: RegExp[] = [
  // UUID format (most common)
  new RegExp(`Session ID:\\s*(${UUID_PATTERN})`, 'i'),
  new RegExp(`Session:\\s*(${UUID_PATTERN})`, 'i'),
  new RegExp(`session_id['":\\s]+(${UUID_PATTERN})`, 'i'),
  new RegExp(`Current session:\\s*(${UUID_PATTERN})`, 'i'),
  // Fallback for non-UUID formats
  /Session ID:\s*([a-zA-Z0-9_-]+)/i,
  /Session:\s*([a-zA-Z0-9_-]+)/i,
];

/**
 * Try multiple patterns to extract session ID
 */
export function extractSessionId(output: string): string | null {
  const cleanOutput = stripAnsi(output);
  for (const pattern of SESSION_ID_PATTERNS) {
    const match = cleanOutput.match(pattern);
    if (match) {
      console.log(`[PREWARM] extractSessionId: found ${match[1]} with pattern ${pattern}`);
      return match[1];
    }
  }
  // Log what we're looking at if no match
  if (cleanOutput.includes('Session') || cleanOutput.includes('session')) {
    console.log(`[PREWARM] extractSessionId: no UUID match, but found 'session' in: ${cleanOutput.slice(-300)}`);
  }
  return null;
}
