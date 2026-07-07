import { describe, test, expect } from 'bun:test';
import {
  countRunningFromNames,
  generateTerminalId,
  buildAgentTerminalEnv,
  resolveRestoredVersion,
  RunningCounts,
  SENSITIVE_ENV_KEYS
} from './terminals';
import { CLAUDE_TITLE, CODEX_TITLE, GEMINI_TITLE, OPENCODE_TITLE, CURSOR_TITLE, SHELL_TITLE } from './utils';

describe('generateTerminalId', () => {
  test('creates id with prefix and counter', () => {
    const id = generateTerminalId('cc', 1);
    expect(id).toMatch(/^cc-\d+-1$/);
  });

  test('creates id with different prefix', () => {
    const id = generateTerminalId('cx', 5);
    expect(id).toMatch(/^cx-\d+-5$/);
  });

  test('includes timestamp', () => {
    const before = Date.now();
    const id = generateTerminalId('gm', 1);
    const after = Date.now();

    const parts = id.split('-');
    const timestamp = parseInt(parts[1], 10);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

describe('countRunningFromNames', () => {
  test('counts zero for empty array', () => {
    const counts = countRunningFromNames([]);
    expect(counts.claude).toBe(0);
    expect(counts.codex).toBe(0);
    expect(counts.gemini).toBe(0);
    expect(counts.opencode).toBe(0);
    expect(counts.cursor).toBe(0);
    expect(counts.shell).toBe(0);
    expect(Object.keys(counts.custom)).toHaveLength(0);
  });

  test('counts claude terminals', () => {
    const counts = countRunningFromNames([CLAUDE_TITLE, CLAUDE_TITLE, 'bash']);
    expect(counts.claude).toBe(2);
    expect(counts.codex).toBe(0);
  });

  test('counts codex terminals', () => {
    const counts = countRunningFromNames([CODEX_TITLE, CODEX_TITLE, CODEX_TITLE]);
    expect(counts.codex).toBe(3);
  });

  test('counts gemini terminals', () => {
    const counts = countRunningFromNames([GEMINI_TITLE]);
    expect(counts.gemini).toBe(1);
  });

  test('counts opencode terminals', () => {
    const counts = countRunningFromNames([OPENCODE_TITLE, OPENCODE_TITLE]);
    expect(counts.opencode).toBe(2);
  });

  test('counts cursor terminals', () => {
    const counts = countRunningFromNames([CURSOR_TITLE, CURSOR_TITLE]);
    expect(counts.cursor).toBe(2);
  });

  test('counts mixed agents', () => {
    const counts = countRunningFromNames([
      CLAUDE_TITLE,
      CODEX_TITLE,
      GEMINI_TITLE,
      OPENCODE_TITLE,
      CURSOR_TITLE,
      CLAUDE_TITLE,
      SHELL_TITLE
    ]);
    expect(counts.claude).toBe(2);
    expect(counts.codex).toBe(1);
    expect(counts.gemini).toBe(1);
    expect(counts.opencode).toBe(1);
    expect(counts.cursor).toBe(1);
    expect(counts.shell).toBe(1);
  });

  test('ignores non-agent terminals', () => {
    const counts = countRunningFromNames(['bash', 'zsh', 'powershell']);
    expect(counts.claude).toBe(0);
    expect(counts.codex).toBe(0);
    expect(counts.gemini).toBe(0);
    expect(counts.opencode).toBe(0);
    expect(counts.cursor).toBe(0);
    expect(counts.shell).toBe(0);
  });

  test('handles terminals with labels', () => {
    const counts = countRunningFromNames([
      `${CLAUDE_TITLE} - auth feature`,
      `${CODEX_TITLE} - database work`
    ]);
    expect(counts.claude).toBe(1);
    expect(counts.codex).toBe(1);
  });
});

describe('buildAgentTerminalEnv', () => {
  test('includes AGENT_SESSION_ID when provided', () => {
    const env = buildAgentTerminalEnv('CC-123', 'session-abc');
    expect(env.AGENT_TERMINAL_ID).toBe('CC-123');
  });

  test('includes AGENT_SESSION_ID', () => {
    const env = buildAgentTerminalEnv('CC-123', null);
    expect(env.AGENT_TERMINAL_ID).toBe('CC-123');
    expect(env.AGENT_SESSION_ID).toBe('');
    expect(env.AGENT_WORKSPACE_DIR).toBe('');
  });

  test('includes AGENT_WORKSPACE_DIR when provided', () => {
    const env = buildAgentTerminalEnv('CC-123', 'session-abc', '/path/to/workspace');
    expect(env.AGENT_TERMINAL_ID).toBe('CC-123');
    expect(env.AGENT_SESSION_ID).toBe('session-abc');
    expect(env.AGENT_WORKSPACE_DIR).toBe('/path/to/workspace');
  });

  test('uses empty AGENT_WORKSPACE_DIR when null', () => {
    const env = buildAgentTerminalEnv('CC-123', null, null);
    expect(env.AGENT_WORKSPACE_DIR).toBe('');
  });

  test('includes AGENT_VERSION when provided', () => {
    const env = buildAgentTerminalEnv('CC-123', 'session-abc', '/ws', '2.1.113');
    expect(env.AGENT_VERSION).toBe('2.1.113');
  });

  test('omitted AGENT_VERSION defaults to empty string', () => {
    const env = buildAgentTerminalEnv('CC-123', 'session-abc');
    expect(env.AGENT_VERSION).toBe('');
  });

  test('every SENSITIVE_ENV_KEY is set to null so VS Code deletes it', () => {
    const env = buildAgentTerminalEnv('CC-123', 'session-abc');
    for (const key of SENSITIVE_ENV_KEYS) {
      expect(env[key]).toBeNull();
    }
  });

  test('dynamically scrubs keys from process.env that match sensitive patterns', () => {
    // Temporarily inject keys into process.env for the test
    process.env.MY_CUSTOM_SECRET = 'super-secret';
    process.env.DB_PASSWORD = 'password123';
    process.env.TEAM_AUTH_TOKEN = 'token-xyz';

    try {
      const env = buildAgentTerminalEnv('CC-123', 'session-abc');
      expect(env.MY_CUSTOM_SECRET).toBeNull();
      expect(env.DB_PASSWORD).toBeNull();
      expect(env.TEAM_AUTH_TOKEN).toBeNull();
    } finally {
      delete process.env.MY_CUSTOM_SECRET;
      delete process.env.DB_PASSWORD;
      delete process.env.TEAM_AUTH_TOKEN;
    }
  });

  test('LLM provider API keys are scrubbed (subscription auth + secrets bundles are the opt-in path)', () => {
    // Project policy: credentials live in Keychain via `agents secrets`, not
    // shell env. Subscription auth (Claude Pro/Max, ChatGPT Plus, Gemini
    // Advanced) keeps working because agent CLIs read their tokens from
    // ~/.claude/, ~/.codex/, ~/.gemini/ config dirs — env vars aren't needed.
    // Users who genuinely need an API key for a run opt in via
    // `agents run <agent> --secrets <bundle>`.
    const llmKeys = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'XAI_API_KEY',
      'MISTRAL_API_KEY',
      'GROQ_API_KEY',
      'DEEPSEEK_API_KEY',
      'PERPLEXITY_API_KEY',
    ];

    for (const key of llmKeys) {
      process.env[key] = 'dummy-key';
    }

    try {
      const env = buildAgentTerminalEnv('CC-123', 'session-abc');
      for (const key of llmKeys) {
        expect(env[key]).toBeNull();
      }
    } finally {
      for (const key of llmKeys) {
        delete process.env[key];
      }
    }
  });

  test('does not scrub standard PWD or internal AGENT_ variables', () => {
    process.env.PWD = '/some/path';
    process.env.AGENT_CUSTOM_VAR = 'value';

    try {
      const env = buildAgentTerminalEnv('CC-123', 'session-abc');
      expect(env.PWD).toBeUndefined();
      expect(env.AGENT_CUSTOM_VAR).toBeUndefined();
    } finally {
      delete process.env.PWD;
      delete process.env.AGENT_CUSTOM_VAR;
    }
  });

  test('does not scrub SQL schema keys (FOREIGN_KEY, PRIMARY_KEY, etc.)', () => {
    // Regression guard: the /_KEY$/ pattern would over-match relational schema
    // env conventions used by some ORMs. Treat these as non-credentials.
    process.env.FOREIGN_KEY = 'user_id';
    process.env.PRIMARY_KEY = 'id';
    process.env.PARTITION_KEY = 'tenant_id';
    try {
      const env = buildAgentTerminalEnv('CC-123', 'session-abc');
      expect(env.FOREIGN_KEY).toBeUndefined();
      expect(env.PRIMARY_KEY).toBeUndefined();
      expect(env.PARTITION_KEY).toBeUndefined();
    } finally {
      delete process.env.FOREIGN_KEY;
      delete process.env.PRIMARY_KEY;
      delete process.env.PARTITION_KEY;
    }
  });

  test('scrubs AWS_SECRET_ACCESS_KEY specifically', () => {
    // Anchor the most common offender so a careless dedup of the list still
    // keeps AWS coverage.
    const env = buildAgentTerminalEnv('CC-123', 'session-abc');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeNull();
    expect(env.AWS_ACCESS_KEY_ID).toBeNull();
  });

  test('scrubSensitive:false keeps the user shell on its normal environment', () => {
    const original = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_realtoken';
    try {
      const env = buildAgentTerminalEnv('SH-123', null, '/ws', undefined, { scrubSensitive: false });
      // No static credential key is deleted...
      for (const key of SENSITIVE_ENV_KEYS) {
        expect(env[key]).toBeUndefined();
      }
      // ...and nothing dynamically matched from process.env is nulled out,
      // so VS Code inherits the user's real value instead of removing it.
      expect(env.GITHUB_TOKEN).toBeUndefined();
      // Internal tracking vars still flow through (shell adoption reads them).
      expect(env.AGENT_TERMINAL_ID).toBe('SH-123');
    } finally {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
    }
  });
});

// Regression guard for the "Cmd+Shift+J loses version pin across reload" bug.
// If this file ever goes red, DO NOT patch the test until you understand why:
// the feature that depends on it (resumeCurrentInBestProfile's already-on-
// usable-version short-circuit) needs this merge to stay correct. See
// resumeInBest.ts → isVersionStillUsable and extension.ts:1892.
describe('resolveRestoredVersion', () => {
  test('prefers env version when both env and persisted are present', () => {
    expect(resolveRestoredVersion('2.1.118', '2.1.113')).toBe('2.1.118');
  });

  test('falls back to persisted version when env is absent', () => {
    expect(resolveRestoredVersion(undefined, '2.1.113')).toBe('2.1.113');
  });

  test('falls back to persisted version when env is empty string', () => {
    // buildAgentTerminalEnv writes AGENT_VERSION: '' when no version is
    // supplied — extractTerminalIdentificationOptions then surfaces it as ''
    // (after the `|| undefined` normalization upstream). Guard both paths.
    expect(resolveRestoredVersion('', '2.1.113')).toBe('2.1.113');
  });

  test('returns undefined when neither source has a version', () => {
    expect(resolveRestoredVersion(undefined, undefined)).toBeUndefined();
  });

  test('returns undefined when both are empty string', () => {
    expect(resolveRestoredVersion('', '')).toBeUndefined();
  });

  test('returns undefined when both are null', () => {
    expect(resolveRestoredVersion(null, null)).toBeUndefined();
  });
});

// Regression guard: a PersistedSession with a pinned version must round-trip
// through the restore-side env builder so that `terminal.creationOptions.env`
// carries `AGENT_VERSION` after a window reload. If this breaks,
// `restoreAgentTerminals` in extension.ts is dropping the version arg.
describe('buildAgentTerminalEnv for a restored session', () => {
  test('a restored session that had a pinned version produces env carrying that pin', () => {
    // Mimic what restoreAgentTerminals does at extension.ts:2818.
    const session = {
      terminalId: 'cl-1776973787768-3',
      sessionId: '3d2f8115-e35f-4c65-87c4-0210a72d613e',
      version: '2.1.113'
    };
    const env = buildAgentTerminalEnv(
      session.terminalId,
      session.sessionId,
      '/ws',
      session.version
    );
    expect(env.AGENT_TERMINAL_ID).toBe(session.terminalId);
    expect(env.AGENT_SESSION_ID).toBe(session.sessionId);
    expect(env.AGENT_VERSION).toBe('2.1.113');
  });

  test('a restored session without a version produces env with empty AGENT_VERSION (legacy pre-0.8.57 sessions)', () => {
    const env = buildAgentTerminalEnv('cl-1-1', 'abc', '/ws', undefined);
    expect(env.AGENT_VERSION).toBe('');
  });
});
