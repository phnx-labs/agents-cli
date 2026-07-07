import { describe, test, expect } from 'bun:test';
import { parseFrontmatter, reattachFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  test('parses YAML frontmatter from real SKILL.md shape', () => {
    const input = `---
name: secrets
description: "Manage named bundles of environment variables backed by macOS Keychain."
argument-hint: "[list|view|create]"
allowed-tools: Bash(agents secrets*)
user-invocable: true
---

# Secrets Skill

Body here.
`;
    const result = parseFrontmatter(input);
    expect(result.hasFrontmatter).toBe(true);
    expect(result.data.name).toBe('secrets');
    expect(result.data['user-invocable']).toBe(true);
    expect(result.body.trim().startsWith('# Secrets Skill')).toBe(true);
    expect(result.body).not.toContain('---');
    expect(result.body).not.toContain('description:');
  });

  test('returns no frontmatter when string has no leading ---', () => {
    const result = parseFrontmatter('# Just a heading\n\nBody.');
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toBe('# Just a heading\n\nBody.');
    expect(result.data).toEqual({});
  });

  test('handles malformed yaml without throwing', () => {
    const result = parseFrontmatter('---\n: : :\n---\nbody');
    // Either fails gracefully (no frontmatter) or parses — both are acceptable, just don't throw
    expect(typeof result.body).toBe('string');
  });
});

describe('reattachFrontmatter', () => {
  test('round-trips frontmatter and body', () => {
    const data = { name: 'x', value: 42 };
    const body = '# Heading\n\nBody.\n';
    const out = reattachFrontmatter(data, body, true);
    expect(out.startsWith('---')).toBe(true);
    expect(out).toContain('name: x');
    expect(out).toContain('value: 42');
    expect(out).toContain('# Heading');
  });

  test('returns body unchanged when no frontmatter present', () => {
    const out = reattachFrontmatter({}, '# Just body', false);
    expect(out).toBe('# Just body');
  });
});
