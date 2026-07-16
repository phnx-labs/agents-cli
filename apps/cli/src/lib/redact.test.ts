/**
 * Redaction is a secret-leak guard: any text that gets logged (daemon logs) or
 * exported (session transcripts) runs through `redactSecrets` first. These tests
 * pin the token classes that must never survive — in particular the AWS / GitHub
 * / npm token forms that a prior *private* daemon copy of this function silently
 * missed, leaking them into `~/.agents/.../logs.jsonl`.
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, knownSecretValuesFromEnv } from './redact.js';

// Token fixtures are ASSEMBLED FROM FRAGMENTS at runtime (via `j`) so no
// contiguous token literal ever appears in this source file — GitHub push
// protection / secret scanners flag file text, not runtime-joined strings.
// The joined values below are synthetic (repeating/placeholder bodies), not
// live credentials. `j` is a plain concatenation.
const j = (...parts: string[]): string => parts.join('');
const B36 = '1234567890abcdefghijklmnopqrstuvwxyz'; // 36-char classic GitHub body

// Each entry: the reconstructed secret + its expected marker after redaction.
const TOKENS: Array<[string, string, string]> = [
  ['AWS access key', j('AKIA', 'IOSFODNN7EXAMPLE'), '[REDACTED_AWS_KEY]'],
  ['GitHub PAT (ghp_)', j('ghp', '_', B36), '[REDACTED_GITHUB_TOKEN]'],
  ['GitHub OAuth token (gho_)', j('gho', '_', B36), '[REDACTED_GITHUB_TOKEN]'],
  ['GitHub server token (ghs_)', j('ghs', '_', B36), '[REDACTED_GITHUB_TOKEN]'],
  ['GitHub refresh token (ghr_)', j('ghr', '_', B36), '[REDACTED_GITHUB_TOKEN]'],
  ['GitHub fine-grained PAT', j('github', '_pat_', '11ABCDEFG0aBcDeFgHiJkL', '_1234567890abcDEF'), '[REDACTED_GITHUB_TOKEN]'],
  ['Anthropic key (sk-ant-api03-)', j('sk-ant', '-api03-', 'abcdefghijklmnopqrstuvwxyz012345'), '[REDACTED_ANTHROPIC_KEY]'],
  ['Stripe live secret key (sk_live_)', j('sk_', 'live_', 'abcdefghijklmnopqrstuvwxyz01'), '[REDACTED_STRIPE_KEY]'],
  ['Stripe restricted key (rk_live_)', j('rk_', 'live_', 'abcdefghijklmnopqrstuvwxyz01'), '[REDACTED_STRIPE_KEY]'],
  ['Slack bot token (xoxb-)', j('xox', 'b', '-123456789012-1234567890123-', 'aBcDeFgHiJkLmNoP'), '[REDACTED_SLACK_TOKEN]'],
  ['Slack user token (xoxp-)', j('xox', 'p', '-123456789012-1234567890123-', 'aBcDeFgHiJkLmNoP'), '[REDACTED_SLACK_TOKEN]'],
  ['Slack app-level token (xapp-)', j('xapp', '-1-A01234567-1234567890123-', 'abcdef012345'), '[REDACTED_SLACK_TOKEN]'],
  ['npm token', j('npm', '_', B36), '[REDACTED_NPM_TOKEN]'],
  ['OpenAI-style key (sk-)', j('sk-', 'abcdefghijklmnopqrstuvwxyz012345'), '[REDACTED_API_KEY]'],
];

describe('redactSecrets', () => {
  const cases: Array<[string, string, string]> = [
    ...TOKENS.map(([label, secret, marker]): [string, string, string] => [label, `pre ${secret} post`, marker]),
    ['JWT', 'jwt eyJhbGci.eyJzdWIiOiIx.SflKxwRJ tail', '[REDACTED_JWT]'],
    ['Bearer header', 'Authorization: Bearer abc.def.ghi-secret', 'Bearer [REDACTED]'],
    ['NAME=value env secret', j('ANTHROPIC_API_KEY=', 'sk-super-secret-value'), '[REDACTED]'],
  ];

  for (const [label, input, marker] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactSecrets(input);
      expect(out).toContain(marker);
    });
  }

  it('does not leave the raw secret in the output', () => {
    for (const [, secret] of TOKENS) {
      const out = redactSecrets(`prefix ${secret} suffix`);
      expect(out).not.toContain(secret);
    }
  });

  it('value-aware pass masks a known secret regardless of format', () => {
    // A credential whose shape matches no pattern still leaks without value-awareness.
    const weird = 'zZ9-plainish-value-no-known-shape';
    const input = `config: {"apiToken":"${weird}"} and bare ${weird}`;
    const naive = redactSecrets(input);
    expect(naive).toContain(weird); // no pattern catches it
    const aware = redactSecrets(input, [weird]);
    expect(aware).not.toContain(weird);
    expect(aware).toContain('[REDACTED]');
  });

  it('value-aware pass ignores trivially short known values', () => {
    const out = redactSecrets('the cat sat on the mat', ['cat']);
    expect(out).toBe('the cat sat on the mat');
  });

  it('leaves non-secret text untouched', () => {
    const plain = 'daemon started; reaped stray pid 4242; next run in 30 seconds';
    expect(redactSecrets(plain)).toBe(plain);
  });
});

describe('knownSecretValuesFromEnv', () => {
  it('selects values of secret-shaped env names, skips ordinary + short ones', () => {
    const env = {
      MY_API_TOKEN: 'super-secret-token-value',
      DB_PASSWORD: 'hunter2-longenough',
      HOME: '/home/someone',
      PATH: '/usr/bin:/bin',
      SHORT_KEY: 'ab', // below the min length
    } as unknown as NodeJS.ProcessEnv;
    const values = knownSecretValuesFromEnv(env);
    expect(values).toContain('super-secret-token-value');
    expect(values).toContain('hunter2-longenough');
    expect(values).not.toContain('/home/someone');
    expect(values).not.toContain('/usr/bin:/bin');
    expect(values).not.toContain('ab');
  });
});
