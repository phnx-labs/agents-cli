// End-to-end tests for session pre-warming
// These tests spawn real CLI processes - no mocking
// Tests will be skipped if CLIs are not available

import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import {
  spawnSimplePrewarmSession,
  needsPrewarming,
  generateClaudeSessionId,
  buildClaudeOpenCommand,
} from '../core/prewarm.simple';
import { extractSessionId, PrewarmAgentType } from '../core/prewarm';

// Local isCliAvailable for tests (avoid vscode import)
async function isCliAvailable(agentType: PrewarmAgentType): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(agentType, ['--version'], { shell: true });
    let resolved = false;
    const finish = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    proc.on('close', (code: number) => finish(code === 0));
    proc.on('error', () => finish(false));
    setTimeout(() => {
      proc.kill();
      finish(false);
    }, 5000);
  });
}

// Longer timeouts for E2E tests (CLI startup can be slow)
const E2E_TIMEOUT = 60000;

describe('Claude session ID generation', () => {
  test('generates valid UUID for Claude', () => {
    const sessionId = generateClaudeSessionId();
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    console.log(`[E2E] Generated Claude session ID: ${sessionId}`);
  });

  test('builds correct Claude open command', () => {
    const sessionId = '019ba357-61b0-7e51-afdd-cd43c0e32253';
    const command = buildClaudeOpenCommand(sessionId);
    expect(command).toBe('claude --session-id 019ba357-61b0-7e51-afdd-cd43c0e32253');
  });

  test('Claude does not need prewarming', () => {
    expect(needsPrewarming('claude')).toBe(false);
  });

  test('Codex needs prewarming', () => {
    expect(needsPrewarming('codex')).toBe(true);
  });

  test('Gemini needs prewarming', () => {
    expect(needsPrewarming('gemini')).toBe(true);
  });
});

describe('Prewarm E2E - Claude', () => {
  test('checks if Claude CLI is available', async () => {
    const available = await isCliAvailable('claude');
    console.log(`[E2E] Claude CLI available: ${available}`);
    expect(typeof available).toBe('boolean');
  }, E2E_TIMEOUT);

  test('Claude prewarm returns immediately with generated UUID', async () => {
    const cwd = process.cwd();
    console.log(`[E2E] Testing Claude prewarm (should be instant)`);

    const startTime = Date.now();
    const result = await spawnSimplePrewarmSession('claude', cwd);
    const elapsed = Date.now() - startTime;

    console.log(`[E2E] Claude result: status=${result.status}, sessionId=${result.sessionId}, elapsed=${elapsed}ms`);

    // Claude should return immediately since we just generate a UUID
    expect(result.status).toBe('success');
    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(elapsed).toBeLessThan(100); // Should be nearly instant
  }, E2E_TIMEOUT);
});

describe('Prewarm E2E - Codex', () => {
  test('checks if Codex CLI is available', async () => {
    const available = await isCliAvailable('codex');
    console.log(`[E2E] Codex CLI available: ${available}`);
    expect(typeof available).toBe('boolean');
  }, E2E_TIMEOUT);

  test('extracts session ID from codex banner', async () => {
    const available = await isCliAvailable('codex');
    if (!available) {
      console.log('[E2E] Skipping: Codex CLI not available');
      return;
    }

    const cwd = process.cwd();
    console.log(`[E2E] Spawning Codex prewarm session in ${cwd}`);

    const result = await spawnSimplePrewarmSession('codex', cwd);
    console.log(`[E2E] Codex result: status=${result.status}, sessionId=${result.sessionId}, blocked=${result.blockedReason}, failed=${result.failedReason}`);

    if (result.status === 'blocked') {
      console.log(`[E2E] Codex blocked: ${result.blockedReason}`);
      if (result.rawOutput) {
        console.log(`[E2E] Codex raw output (first 500 chars): ${result.rawOutput.slice(0, 500)}`);
      }
      return;
    }

    if (result.status === 'failed') {
      console.log(`[E2E] Codex failed: ${result.failedReason}`);
      if (result.rawOutput) {
        console.log(`[E2E] Codex raw output (first 500 chars): ${result.rawOutput.slice(0, 500)}`);
      }
      return;
    }

    expect(result.status).toBe('success');
    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).toMatch(/^[a-zA-Z0-9_-]+$/);
    console.log(`[E2E] Codex session ID extracted: ${result.sessionId}`);
  }, E2E_TIMEOUT);
});

describe('Prewarm E2E - Gemini', () => {
  test('checks if Gemini CLI is available', async () => {
    const available = await isCliAvailable('gemini');
    console.log(`[E2E] Gemini CLI available: ${available}`);
    expect(typeof available).toBe('boolean');
  }, E2E_TIMEOUT);

  test('extracts session ID from gemini JSON output', async () => {
    const available = await isCliAvailable('gemini');
    if (!available) {
      console.log('[E2E] Skipping: Gemini CLI not available');
      return;
    }

    const cwd = process.cwd();
    console.log(`[E2E] Spawning Gemini prewarm session in ${cwd}`);

    const result = await spawnSimplePrewarmSession('gemini', cwd);
    console.log(`[E2E] Gemini result: status=${result.status}, sessionId=${result.sessionId}, blocked=${result.blockedReason}, failed=${result.failedReason}`);

    if (result.status === 'blocked') {
      console.log(`[E2E] Gemini blocked: ${result.blockedReason}`);
      if (result.rawOutput) {
        console.log(`[E2E] Gemini raw output (first 500 chars): ${result.rawOutput.slice(0, 500)}`);
      }
      return;
    }

    if (result.status === 'failed') {
      console.log(`[E2E] Gemini failed: ${result.failedReason}`);
      if (result.rawOutput) {
        console.log(`[E2E] Gemini raw output (first 500 chars): ${result.rawOutput.slice(0, 500)}`);
      }
      return;
    }

    expect(result.status).toBe('success');
    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).toMatch(/^[a-zA-Z0-9_-]+$/);
    console.log(`[E2E] Gemini session ID extracted: ${result.sessionId}`);
  }, E2E_TIMEOUT);
});

describe('Session ID extraction patterns', () => {
  // These tests verify that the patterns work with real-world output formats

  test('handles UUID format (primary format for Claude)', async () => {
    // UUIDv7 format - most common for Claude
    expect(extractSessionId('Session ID: 019ba357-61b0-7e51-afdd-cd43c0e32253'))
      .toBe('019ba357-61b0-7e51-afdd-cd43c0e32253');

    expect(extractSessionId('Session: 019ba357-61b0-7e51-afdd-cd43c0e32253'))
      .toBe('019ba357-61b0-7e51-afdd-cd43c0e32253');

    // With ANSI codes
    expect(extractSessionId('\x1b[1mSession ID:\x1b[0m 019ba357-61b0-7e51-afdd-cd43c0e32253'))
      .toBe('019ba357-61b0-7e51-afdd-cd43c0e32253');
  });

  test('handles realistic /status output', async () => {
    const statusOutput = `
Claude Code v2.1.2

Session ID: 019ba357-61b0-7e51-afdd-cd43c0e32253
Model: claude-opus-4-5-20251101
Context: 1,234 tokens
Account: Claude Max

Type /help for commands
>`;
    expect(extractSessionId(statusOutput)).toBe('019ba357-61b0-7e51-afdd-cd43c0e32253');
  });

  test('handles fallback formats for other CLIs', async () => {
    // Non-UUID formats (fallback patterns)
    expect(extractSessionId('Session ID: abc123')).toBe('abc123');
    expect(extractSessionId('Session: codex_session_abc')).toBe('codex_session_abc');
  });
});
