import { describe, it, expect } from 'vitest';
import { buildPasswordItemTemplate, toEnvKey, slugify } from '../onepassword.js';

describe('buildPasswordItemTemplate', () => {
  it('produces a CONCEALED password field whose id matches what extractSecrets prefers', () => {
    const tpl = buildPasswordItemTemplate('STRIPE_API_KEY', 'sk_live_abc');
    expect(tpl.title).toBe('STRIPE_API_KEY');
    expect(tpl.category).toBe('PASSWORD');
    expect(tpl.fields).toHaveLength(1);
    expect(tpl.fields[0]).toEqual({
      id: 'password',
      type: 'CONCEALED',
      purpose: 'PASSWORD',
      label: 'password',
      value: 'sk_live_abc',
    });
  });

  it('serializes to valid JSON for op stdin', () => {
    const tpl = buildPasswordItemTemplate('FOO', 'bar"baz\nqux');
    const round = JSON.parse(JSON.stringify(tpl));
    expect(round.fields[0].value).toBe('bar"baz\nqux');
  });

  it('round-trips with toEnvKey: title -> envKey is identity for valid env keys', () => {
    expect(toEnvKey(buildPasswordItemTemplate('STRIPE_API_KEY', 'x').title)).toBe('STRIPE_API_KEY');
    expect(toEnvKey(buildPasswordItemTemplate('DB_URL_2', 'x').title)).toBe('DB_URL_2');
  });

  it('tags items so they can be identified later', () => {
    expect(buildPasswordItemTemplate('K', 'v').tags).toContain('agents-cli');
  });
});

describe('slugify', () => {
  it('lowercases and dasherizes vault names', () => {
    expect(slugify('Rush Prod')).toBe('rush-prod');
    expect(slugify('  Trim  Me  ')).toBe('trim-me');
  });
});
