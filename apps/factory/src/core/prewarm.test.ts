import { describe, test, expect } from 'bun:test';
import {
  PREWARM_CONFIGS,
  parseSessionId,
  isCliReady,
  detectBlockingPrompt,
  stripAnsi,
  extractSessionId,
  needsReplenishment,
  selectBestSession,
  buildResumeCommand,
  buildVersionedResumeCommand,
  supportsPrewarming,
  PrewarmedSession,
} from './prewarm';

describe('parseSessionId', () => {
  test('parses Claude ULID session ID', () => {
    const output = 'Session ID: 01J9Z5B4C7D8E9F0G1H2J3K4L5';
    const sessionId = parseSessionId(output, PREWARM_CONFIGS.claude);
    expect(sessionId).toBe('01J9Z5B4C7D8E9F0G1H2J3K4L5');
  });

  test('parses Session line without ID label', () => {
    const output = 'Session: 01J9Z5B4C7D8E9F0G1H2J3K4L5';
    const sessionId = parseSessionId(output, PREWARM_CONFIGS.codex);
    expect(sessionId).toBe('01J9Z5B4C7D8E9F0G1H2J3K4L5');
  });

  test('parses session ID with dashes', () => {
    const output = 'Session: abc123-def456-ghi789';
    const sessionId = parseSessionId(output, PREWARM_CONFIGS.codex);
    expect(sessionId).toBe('abc123-def456-ghi789');
  });

  test('parses session ID with underscores', () => {
    const output = 'Session ID: abc_123_def';
    const sessionId = parseSessionId(output, PREWARM_CONFIGS.claude);
    expect(sessionId).toBe('abc_123_def');
  });

  test('returns null for no match', () => {
    const output = 'Welcome to Claude Code';
    const sessionId = parseSessionId(output, PREWARM_CONFIGS.claude);
    expect(sessionId).toBeNull();
  });

  test('handles multiline output', () => {
    const output = `Claude Code v2.1.2

Session ID: 01ABCDEFGHIJKLMN

Type /help for commands`;
    const sessionId = parseSessionId(output, PREWARM_CONFIGS.claude);
    expect(sessionId).toBe('01ABCDEFGHIJKLMN');
  });
});

describe('stripAnsi', () => {
  test('strips basic color codes', () => {
    const input = '\x1b[32mSession ID:\x1b[0m abc123';
    const output = stripAnsi(input);
    expect(output).toBe('Session ID: abc123');
  });

  test('strips bold and underline', () => {
    const input = '\x1b[1mBold\x1b[0m and \x1b[4munderline\x1b[0m';
    const output = stripAnsi(input);
    expect(output).toBe('Bold and underline');
  });

  test('strips cursor movement codes', () => {
    const input = '\x1b[2J\x1b[HHello';
    const output = stripAnsi(input);
    expect(output).toBe('Hello');
  });

  test('handles text without ANSI codes', () => {
    const input = 'Plain text without codes';
    const output = stripAnsi(input);
    expect(output).toBe('Plain text without codes');
  });

  test('strips multiple codes in sequence', () => {
    const input = '\x1b[1m\x1b[32m\x1b[4mStyled\x1b[0m';
    const output = stripAnsi(input);
    expect(output).toBe('Styled');
  });
});

describe('extractSessionId', () => {
  test('extracts UUID format session ID (most common)', () => {
    // UUIDv7 format used by Claude
    expect(extractSessionId('Session ID: 019ba357-61b0-7e51-afdd-cd43c0e32253'))
      .toBe('019ba357-61b0-7e51-afdd-cd43c0e32253');
    expect(extractSessionId('Session: 019ba357-61b0-7e51-afdd-cd43c0e32253'))
      .toBe('019ba357-61b0-7e51-afdd-cd43c0e32253');
  });

  test('extracts session ID using fallback patterns', () => {
    expect(extractSessionId('Session ID: abc123')).toBe('abc123');
    expect(extractSessionId('Session: def456')).toBe('def456');
  });

  test('handles ANSI codes in output', () => {
    const output = '\x1b[32mSession ID:\x1b[0m 019ba357-61b0-7e51-afdd-cd43c0e32253';
    expect(extractSessionId(output)).toBe('019ba357-61b0-7e51-afdd-cd43c0e32253');
  });

  test('extracts UUID from multiline /status output', () => {
    const output = `
Claude Code v2.1.2

Session ID: 019ba357-61b0-7e51-afdd-cd43c0e32253
Model: claude-opus-4-5-20251101
Context: 1,234 tokens

Type /help for commands
>`;
    expect(extractSessionId(output)).toBe('019ba357-61b0-7e51-afdd-cd43c0e32253');
  });

  test('returns null for no match', () => {
    expect(extractSessionId('No session here')).toBeNull();
    expect(extractSessionId('Session ID: ')).toBeNull(); // Empty
  });
});

describe('detectBlockingPrompt', () => {
  test('detects trust prompt', () => {
    const output = 'Do you trust the files in this folder?\n/Users/test';
    expect(detectBlockingPrompt(output)).toBe('trust_prompt');
  });

  test('detects auth required', () => {
    expect(detectBlockingPrompt('Please log in to continue')).toBe('auth_required');
    expect(detectBlockingPrompt('Authentication required')).toBe('auth_required');
    expect(detectBlockingPrompt('API key not found')).toBe('auth_required');
  });

  test('detects rate limit', () => {
    expect(detectBlockingPrompt('Rate limit exceeded')).toBe('rate_limit');
    expect(detectBlockingPrompt('Too many requests, please try again later')).toBe('rate_limit');
  });

  test('returns null for normal output', () => {
    expect(detectBlockingPrompt('Claude Code v2.1.2\n>')).toBeNull();
    expect(detectBlockingPrompt('Welcome to Codex')).toBeNull();
  });
});

describe('isCliReady', () => {
  test('detects Claude ready state with prompt', () => {
    expect(isCliReady('Claude Code v2.1.2\n>', 'claude')).toBe(true);
    expect(isCliReady('Welcome\n>', 'claude')).toBe(true);
  });

  test('detects Claude ready with version banner', () => {
    expect(isCliReady('Claude Code v2.1.2', 'claude')).toBe(true);
  });

  test('detects Codex ready state', () => {
    expect(isCliReady('OpenAI Codex\n>', 'codex')).toBe(true);
    expect(isCliReady('Context window: 128k', 'codex')).toBe(true);
  });

  test('detects Gemini ready state', () => {
    expect(isCliReady('Gemini\n>', 'gemini')).toBe(true);
  });

  test('detects Cursor ready state', () => {
    expect(isCliReady('{"type":"result","session_id":"abc123"}', 'cursor')).toBe(true);
    expect(isCliReady('cursor-agent output>', 'cursor')).toBe(true);
  });

  test('not ready during startup', () => {
    expect(isCliReady('Loading...', 'claude')).toBe(false);
    expect(isCliReady('Initializing', 'codex')).toBe(false);
  });
});

describe('needsReplenishment', () => {
  test('returns needed count when pool is empty', () => {
    const pool = { available: [], pending: 0 };
    expect(needsReplenishment(pool, 3)).toBe(3);
  });

  test('returns 0 when pool is full', () => {
    const pool = { available: [{} as PrewarmedSession, {} as PrewarmedSession, {} as PrewarmedSession], pending: 0 };
    expect(needsReplenishment(pool, 3)).toBe(0);
  });

  test('accounts for pending sessions', () => {
    const pool = { available: [{}  as PrewarmedSession], pending: 1 };
    expect(needsReplenishment(pool, 3)).toBe(1);
  });

  test('returns 0 when available + pending >= target', () => {
    const pool = { available: [{} as PrewarmedSession], pending: 2 };
    expect(needsReplenishment(pool, 3)).toBe(0);
  });
});

describe('selectBestSession', () => {
  const session1: PrewarmedSession = {
    agentType: 'claude',
    sessionId: 'session1',
    createdAt: 1000,
    workingDirectory: '/home/user/project1',
  };

  const session2: PrewarmedSession = {
    agentType: 'claude',
    sessionId: 'session2',
    createdAt: 2000,
    workingDirectory: '/home/user/project2',
  };

  test('returns null for empty array', () => {
    expect(selectBestSession([], '/any/path')).toBeNull();
  });

  test('prefers session with matching cwd', () => {
    const result = selectBestSession([session1, session2], '/home/user/project2');
    expect(result?.sessionId).toBe('session2');
  });

  test('returns oldest session when no cwd match', () => {
    const result = selectBestSession([session2, session1], '/home/user/other');
    expect(result?.sessionId).toBe('session1');
  });
});

describe('buildResumeCommand', () => {
  test('builds Claude resume command', () => {
    const session: PrewarmedSession = {
      agentType: 'claude',
      sessionId: 'abc123',
      createdAt: Date.now(),
      workingDirectory: '/test',
    };
    expect(buildResumeCommand(session)).toBe('claude -r abc123');
  });

  test('builds Codex resume command', () => {
    const session: PrewarmedSession = {
      agentType: 'codex',
      sessionId: 'def456',
      createdAt: Date.now(),
      workingDirectory: '/test',
    };
    expect(buildResumeCommand(session)).toBe('codex resume def456');
  });

  test('builds Gemini resume command', () => {
    const session: PrewarmedSession = {
      agentType: 'gemini',
      sessionId: 'ghi789',
      createdAt: Date.now(),
      workingDirectory: '/test',
    };
    expect(buildResumeCommand(session)).toBe('gemini --resume ghi789');
  });

  test('builds Cursor resume command', () => {
    const session: PrewarmedSession = {
      agentType: 'cursor',
      sessionId: '874384ec-7236-4887-aa1c-f627754ce0c0',
      createdAt: Date.now(),
      workingDirectory: '/test',
    };
    expect(buildResumeCommand(session)).toBe('cursor-agent --resume=874384ec-7236-4887-aa1c-f627754ce0c0');
  });
});

describe('buildVersionedResumeCommand', () => {
  test('pins Claude resume to the requested version', () => {
    expect(buildVersionedResumeCommand('claude', 'abc123', '2.1.113')).toBe('claude@2.1.113 -r abc123');
  });

  test('leaves Claude unpinned when version is missing', () => {
    expect(buildVersionedResumeCommand('claude', 'abc123')).toBe('claude -r abc123');
  });

  test('pins non-Claude resume commands too', () => {
    expect(buildVersionedResumeCommand('codex', 'def456', '0.124.0')).toBe('codex@0.124.0 resume def456');
    expect(buildVersionedResumeCommand('cursor', 'ghi789', '1.2.3')).toBe('cursor-agent@1.2.3 --resume=ghi789');
  });
});

describe('supportsPrewarming', () => {
  test('returns true for supported agents', () => {
    expect(supportsPrewarming('claude')).toBe(true);
    expect(supportsPrewarming('codex')).toBe(true);
    expect(supportsPrewarming('gemini')).toBe(true);
    expect(supportsPrewarming('cursor')).toBe(true);
    expect(supportsPrewarming('opencode')).toBe(true);
  });

  test('returns false for unsupported agents', () => {
    expect(supportsPrewarming('random')).toBe(false);
  });
});

describe('PREWARM_CONFIGS', () => {
  test('claude config has correct exit sequence', () => {
    // Claude needs Esc, then Ctrl+C twice
    expect(PREWARM_CONFIGS.claude.exitSequence).toEqual(['\x1b', '\x03', '\x03']);
  });

  test('codex config has correct exit sequence', () => {
    // Codex just needs Ctrl+C twice
    expect(PREWARM_CONFIGS.codex.exitSequence).toEqual(['\x03', '\x03']);
  });

  test('gemini config has correct status command', () => {
    // Gemini uses /stats instead of /status
    expect(PREWARM_CONFIGS.gemini.statusCommand).toBe('/stats');
    expect(PREWARM_CONFIGS.gemini.exitSequence).toEqual(['\x03', '\x03']);
  });

  test('cursor config has correct settings', () => {
    expect(PREWARM_CONFIGS.cursor.command).toBe('cursor-agent');
    expect(PREWARM_CONFIGS.cursor.exitSequence).toEqual(['\x03', '\x03']);
    expect(PREWARM_CONFIGS.cursor.resumeCommand('abc123')).toBe('cursor-agent --resume=abc123');
  });
});
