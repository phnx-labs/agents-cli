import { describe, expect, test } from 'bun:test';
import { generateCommitMessageWithClaude, sanitizeCommitMessage } from './commitgen';

describe('sanitizeCommitMessage', () => {
  test('returns null for empty input', () => {
    expect(sanitizeCommitMessage('')).toBeNull();
    expect(sanitizeCommitMessage('   ')).toBeNull();
    expect(sanitizeCommitMessage('\n\n')).toBeNull();
  });

  test('takes first non-empty line', () => {
    expect(sanitizeCommitMessage('feat: add login\n\nextra body')).toBe('feat: add login');
    expect(sanitizeCommitMessage('\n\nfix: oops\n')).toBe('fix: oops');
  });

  test('strips wrapping quotes and backticks', () => {
    expect(sanitizeCommitMessage('"feat: add login"')).toBe('feat: add login');
    expect(sanitizeCommitMessage("'fix: bug'")).toBe('fix: bug');
    expect(sanitizeCommitMessage('`docs: update`')).toBe('docs: update');
  });

  test('rejects responses that are not conventional commits', () => {
    expect(sanitizeCommitMessage("I can't help with that")).toBeNull();
    expect(sanitizeCommitMessage('Sorry, no diff provided.')).toBeNull();
    expect(sanitizeCommitMessage('- bullet point')).toBeNull();
  });

  test('accepts all standard conventional types', () => {
    expect(sanitizeCommitMessage('feat: x')).toBe('feat: x');
    expect(sanitizeCommitMessage('fix: x')).toBe('fix: x');
    expect(sanitizeCommitMessage('docs: x')).toBe('docs: x');
    expect(sanitizeCommitMessage('refactor: x')).toBe('refactor: x');
    expect(sanitizeCommitMessage('test: x')).toBe('test: x');
    expect(sanitizeCommitMessage('build: x')).toBe('build: x');
    expect(sanitizeCommitMessage('release: x')).toBe('release: x');
    expect(sanitizeCommitMessage('chore: x')).toBe('chore: x');
  });

  test('truncates very long messages', () => {
    const long = 'feat: ' + 'x'.repeat(500);
    const result = sanitizeCommitMessage(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(200);
  });
});

describe('generateCommitMessageWithClaude (integration, may be slow)', () => {
  test('produces a conventional-commit message for a simple diff', async () => {
    const prompt = `Write ONE conventional-commit message for the staged changes below.

Respond IMMEDIATELY with only the commit message. Do NOT investigate, do NOT read files, do NOT use tools.

Format: <type>: <description>
Types: feat, fix, docs, refactor, test, build, release, chore

Rules:
- Single line, under 72 characters.
- Lowercase. Imperative mood.
- No body, no trailers.

Git status:
Staged Modified: README.md

Diff preview:
File: README.md (2 lines changed)
+# Hello World
-# Hello

Output the commit message and nothing else.`;

    const result = await generateCommitMessageWithClaude(prompt, 90_000);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^[a-z]+:\s+\S/);
  }, 95_000);
});
