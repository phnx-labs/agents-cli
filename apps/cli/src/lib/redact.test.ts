/**
 * Redaction is a secret-leak guard: any text that gets logged (daemon logs) or
 * exported (session transcripts) runs through `redactSecrets` first. These tests
 * pin the token classes that must never survive — in particular the AWS / GitHub
 * / npm token forms that a prior *private* daemon copy of this function silently
 * missed, leaking them into `~/.agents/.../logs.jsonl`.
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  const cases: Array<[string, string, string]> = [
    // [label, input containing a secret, marker that must appear post-redaction]
    ['AWS access key', 'creds AKIAIOSFODNN7EXAMPLE end', '[REDACTED_AWS_KEY]'],
    ['GitHub PAT', 'token ghp_1234567890abcdefghijklmnopqrstuvwxyz here', '[REDACTED_GITHUB_TOKEN]'],
    ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789 done', '[REDACTED_NPM_TOKEN]'],
    ['OpenAI-style key', 'key sk-abcdefghijklmnopqrstuvwxyz012345 tail', '[REDACTED_API_KEY]'],
    ['JWT', 'jwt eyJhbGci.eyJzdWIiOiIx.SflKxwRJ tail', '[REDACTED_JWT]'],
    ['Bearer header', 'Authorization: Bearer abc.def.ghi-secret', 'Bearer [REDACTED]'],
    ['NAME=value env secret', 'ANTHROPIC_API_KEY=sk-super-secret-value', '[REDACTED]'],
  ];

  for (const [label, input, marker] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactSecrets(input);
      expect(out).toContain(marker);
    });
  }

  it('does not leave the raw secret in the output', () => {
    const secrets = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
    ];
    for (const s of secrets) {
      const out = redactSecrets(`prefix ${s} suffix`);
      expect(out).not.toContain(s);
    }
  });

  it('leaves non-secret text untouched', () => {
    const plain = 'daemon started; reaped stray pid 4242; next run in 30 seconds';
    expect(redactSecrets(plain)).toBe(plain);
  });
});
