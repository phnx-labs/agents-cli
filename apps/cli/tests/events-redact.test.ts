import { describe, it, expect } from 'vitest';
import { redactPrompt, redactArgs } from '../src/lib/events.js';

describe('redactPrompt', () => {
  it('replaces raw text with length and short sha', () => {
    const r = redactPrompt('sk_live_FAKE_SECRET_12345');
    expect(JSON.stringify(r)).not.toContain('sk_live_FAKE_SECRET_12345');
    expect(r.prompt_length).toBe(25);
    expect(r.prompt_sha256).toMatch(/^[a-f0-9]{16}$/);
  });

  it('drops the raw "prompt" field entirely', () => {
    const r = redactPrompt('whatever') as Record<string, unknown>;
    expect(r.prompt).toBeUndefined();
  });

  it('returns empty object for nullish input', () => {
    expect(redactPrompt(undefined)).toEqual({});
    expect(redactPrompt(null)).toEqual({});
  });

  it('produces stable hashes for identical input', () => {
    expect(redactPrompt('hello').prompt_sha256).toBe(redactPrompt('hello').prompt_sha256);
  });
});

describe('redactArgs', () => {
  it('masks stripe-style keys', () => {
    expect(redactArgs(['--key', 'sk_live_ABCDEF'])).toEqual(['--key', '[REDACTED]']);
    expect(redactArgs(['pk_test_XYZ'])).toEqual(['[REDACTED]']);
  });

  it('masks GitHub PATs', () => {
    expect(redactArgs(['ghp_PLACEHOLDER_TOKEN_VALUE'])).toEqual(['[REDACTED]']);
  });

  it('masks Slack tokens', () => {
    expect(redactArgs(['xoxb-1-2-3-abc'])).toEqual(['[REDACTED]']);
  });

  it('masks AWS access keys', () => {
    expect(redactArgs(['AKIAIOSFODNN7EXAMPLE'])).toEqual(['[REDACTED]']);
  });

  it('masks Bearer authorization headers', () => {
    expect(redactArgs(['Bearer eyJhbGciOi'])).toEqual(['[REDACTED]']);
  });

  it('masks JWT-shaped tokens', () => {
    expect(redactArgs(['eyJhbGciOiJIUzI1NiJ9.payload'])).toEqual(['[REDACTED]']);
  });

  it('masks paths into known secret directories', () => {
    expect(redactArgs(['/home/u/.agents/secrets/notion.so/json'])).toEqual(['[REDACTED]']);
    expect(redactArgs(['/Users/m/.rush/user.yaml'])).toEqual(['[REDACTED]']);
  });

  it('leaves benign args untouched', () => {
    expect(redactArgs(['claude', '--prompt', 'hello world', '--mode', 'edit']))
      .toEqual(['claude', '--prompt', 'hello world', '--mode', 'edit']);
  });

  it('passes undefined through', () => {
    expect(redactArgs(undefined)).toBeUndefined();
  });
});
