import { describe, expect, it } from 'vitest';
import { extractSessionTopic, cleanSessionPrompt, HEADLESS_PLAN_MODE_PREFIX } from './prompt.js';

describe('extractSessionTopic', () => {
  it('returns undefined for empty input', () => {
    expect(extractSessionTopic('')).toBeUndefined();
    expect(extractSessionTopic('   ')).toBeUndefined();
  });

  it('extracts first meaningful line from normal input', () => {
    expect(extractSessionTopic('Fix the login bug')).toBe('Fix the login bug');
  });

  it('skips whole-message patterns', () => {
    expect(extractSessionTopic('<permissions instructions>allow bash</permissions instructions>')).toBeUndefined();
  });

  it('strips HEADLESS PLAN MODE prefix and returns the real task', () => {
    const raw = `${HEADLESS_PLAN_MODE_PREFIX} This mode works like normal plan mode with one exception: you cannot write to ~/.claude/plans/ directory. Instead of writing a plan file, output your complete plan/response as your final message.

Fix the authentication bug in login.ts`;
    expect(extractSessionTopic(raw)).toBe('Fix the authentication bug in login.ts');
  });

  it('strips prefix when header has multiple lines before blank line', () => {
    const raw = `${HEADLESS_PLAN_MODE_PREFIX}
Line two of header.
Line three.

Refactor the payment module`;
    expect(extractSessionTopic(raw)).toBe('Refactor the payment module');
  });

  it('returns undefined when prefix is present but no real prompt follows', () => {
    const raw = `${HEADLESS_PLAN_MODE_PREFIX} Some header text with no blank line after`;
    expect(extractSessionTopic(raw)).toBeUndefined();
  });

  it('returns undefined when prefix is present and only whitespace follows blank line', () => {
    const raw = `${HEADLESS_PLAN_MODE_PREFIX} Some header.\n\n   `;
    expect(extractSessionTopic(raw)).toBeUndefined();
  });

  it('does not strip prefix when message does not start with it', () => {
    const msg = 'Normal task that mentions HEADLESS PLAN MODE somewhere in the middle';
    expect(extractSessionTopic(msg)).toBe('Normal task that mentions HEADLESS PLAN MODE somewhere in the middle');
  });

  it('handles leading whitespace before the prefix', () => {
    const raw = `  ${HEADLESS_PLAN_MODE_PREFIX} Header content.\n\nWrite tests for the new feature`;
    expect(extractSessionTopic(raw)).toBe('Write tests for the new feature');
  });
});

describe('cleanSessionPrompt', () => {
  it('removes known noise lines', () => {
    const raw = 'cwd: /workspace\nFix the bug\nshell: bash\n2024-01-01';
    expect(cleanSessionPrompt(raw)).toBe('Fix the bug');
  });

  it('strips XML-like tags', () => {
    expect(cleanSessionPrompt('<context>some info</context>\nDo something')).toBe('some info\nDo something');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(cleanSessionPrompt('   ')).toBe('');
  });
});
