import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sshSrc = readFileSync(join(here, 'ssh.ts'), 'utf8');

describe('ssh driver CDP launch args', () => {
  it('never sets --remote-allow-origins=* (DNS-rebind / cross-origin CDP risk)', () => {
    expect(sshSrc).not.toMatch(/--remote-allow-origins=\*/);
  });

  it('scopes --remote-allow-origins to a 127.0.0.1 URL with the forwarded port', () => {
    expect(sshSrc).toMatch(/--remote-allow-origins=http:\/\/127\.0\.0\.1:\$\{port\}/);
  });
});
