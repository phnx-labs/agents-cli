// Terminal state management following API.md architecture
// Pure functions are testable, VS Code integration in terminals.vscode.ts

import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  GEMINI_TITLE,
  OPENCODE_TITLE,
  CURSOR_TITLE,
  SHELL_TITLE,
  getTerminalDisplayInfo
} from './utils';

// Running counts for settings panel
export interface RunningCounts {
  claude: number;
  codex: number;
  gemini: number;
  opencode: number;
  cursor: number;
  shell: number;
  custom: Record<string, number>;
}

// Count running agents from terminal names (pure function)
export function countRunningFromNames(terminalNames: string[]): RunningCounts {
  const counts: RunningCounts = {
    claude: 0,
    codex: 0,
    gemini: 0,
    opencode: 0,
    cursor: 0,
    shell: 0,
    custom: {}
  };

  for (const name of terminalNames) {
    const info = getTerminalDisplayInfo({ name });
    if (!info.isAgent || !info.prefix) continue;

    switch (info.prefix) {
      case CLAUDE_TITLE:
        counts.claude++;
        break;
      case CODEX_TITLE:
        counts.codex++;
        break;
      case GEMINI_TITLE:
        counts.gemini++;
        break;
      case OPENCODE_TITLE:
        counts.opencode++;
        break;
      case CURSOR_TITLE:
        counts.cursor++;
        break;
      case SHELL_TITLE:
        counts.shell++;
        break;
      default:
        counts.custom[info.prefix] = (counts.custom[info.prefix] || 0) + 1;
        break;
    }
  }

  return counts;
}

// Generate terminal ID
export function generateTerminalId(prefix: string, counter: number): string {
  return `${prefix}-${Date.now()}-${counter}`;
}

// Infrastructure credentials that get deleted from the spawned agent terminal's
// environment. A prompt-injected agent could otherwise shell out and read them.
// Setting a key to null in VS Code's TerminalOptions.env removes it.
export const SENSITIVE_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'NPM_AUTH_TOKEN',
  'DATABASE_URL',
  'DATABASE_PASSWORD',
  'PG_PASSWORD',
  'PGPASSWORD',
  'MYSQL_PWD',
  'STRIPE_SECRET_KEY',
  'STRIPE_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_USER_TOKEN',
  'SLACK_APP_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'VERCEL_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
] as const;

// Patterns that identify potentially sensitive environment variables.
const SENSITIVE_PATTERNS = [
  /_KEY$/,
  /_TOKEN$/,
  /_SECRET$/,
  /_PASSWORD$/,
  /PASSWORD$/,
  /_PWD$/,
  /_AUTH$/,
];

// LLM provider keys are scrubbed too. Subscription auth (Claude Pro/Max,
// ChatGPT Plus, Gemini Advanced) keeps working because the agent CLIs read
// their tokens from ~/.claude/, ~/.codex/, ~/.gemini/ config dirs — not env
// vars. Users who genuinely need an API key for a particular run opt in
// explicitly via `agents run <agent> --secrets <bundle>`, which agents-cli
// injects from Keychain. That keeps credential storage centralized in
// `agents secrets` (macOS Keychain, biometry-gated) as project policy
// requires.
// SQL/relational schema env names end in _KEY but are not credentials.
// Without this exemption the dynamic /_KEY$/ pattern would scrub them.
const PATTERN_FALSE_POSITIVES = new Set([
  'FOREIGN_KEY',
  'PRIMARY_KEY',
  'PARTITION_KEY',
  'SORT_KEY',
  'HASH_KEY',
]);

export function isSensitiveEnvKey(key: string): boolean {
  if (key === 'PWD') return false; // Standard POSIX env var
  if (key.startsWith('AGENT_')) return false; // Our own internal tracking vars
  if (PATTERN_FALSE_POSITIVES.has(key)) return false;

  if (SENSITIVE_ENV_KEYS.includes(key as any)) return true;
  return SENSITIVE_PATTERNS.some(p => p.test(key));
}

/**
 * Build environment variables for agent terminals.
 *
 * @param terminalId - Internal tracking ID for this terminal
 * @param sessionId - CLI session UUID (for resume/history)
 * @param workspacePath - Workspace root path (for MCP server to identify project)
 * @param version - Pinned agent version (e.g. "2.1.113"); omitted when the
 *   agent was launched via its PATH shim and the concrete version is unknown.
 * @param options.scrubSensitive - Whether to delete infra/credential env vars
 *   from the spawned terminal. Defaults to `true` for agent terminals, where a
 *   prompt-injected agent could shell out and read them. Set to `false` for a
 *   user-opened shell tab: the user drives it directly (no agent), so it should
 *   load their normal environment, credentials included.
 */
export function buildAgentTerminalEnv(
  terminalId: string,
  sessionId: string | null | undefined,
  workspacePath: string | null | undefined = undefined,
  version: string | null | undefined = undefined,
  options: { scrubSensitive?: boolean } = {}
): Record<string, string | null> {
  const { scrubSensitive = true } = options;

  const env: Record<string, string | null> = {
    AGENT_TERMINAL_ID: terminalId,
    AGENT_SESSION_ID: sessionId ?? '',
    AGENT_WORKSPACE_DIR: workspacePath ?? '',
    AGENT_VERSION: version ?? '',
    DISABLE_AUTO_TITLE: 'true',
    PROMPT_COMMAND: ''
  };

  if (!scrubSensitive) {
    return env;
  }

  // 1. Scrub known static keys
  for (const key of SENSITIVE_ENV_KEYS) {
    env[key] = null;
  }

  // 2. Dynamically scrub anything in process.env that looks sensitive
  for (const key of Object.keys(process.env)) {
    if (isSensitiveEnvKey(key)) {
      env[key] = null;
    }
  }

  return env;
}

/**
 * Pick the version to pin on a restored terminal. Prefers the env var (most
 * recent source of truth — set when the terminal was (re)created) and falls
 * back to the persisted session's version. Returns undefined if neither has
 * a pin — the terminal restores without a version, and Cmd+Shift+J falls
 * through to the legacy switch path.
 *
 * Empty string counts as absent — that's what `buildAgentTerminalEnv` writes
 * when no version is supplied, and it must not round-trip as a real pin.
 */
export function resolveRestoredVersion(
  envVersion: string | null | undefined,
  persistedVersion: string | null | undefined
): string | undefined {
  if (envVersion) return envVersion;
  if (persistedVersion) return persistedVersion;
  return undefined;
}
