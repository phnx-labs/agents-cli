import { describe, it, expect } from 'vitest';
import { validateHetznerToken } from './lease.js';

const fakeFetch = (status: number, throws = false): typeof fetch =>
  (async () => {
    if (throws) throw new Error('network down');
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;

describe('validateHetznerToken', () => {
  it('returns valid on 200', async () => {
    expect(await validateHetznerToken('t', fakeFetch(200))).toBe('valid');
  });

  it('returns invalid on 401 and 403 (bad/insufficient token)', async () => {
    expect(await validateHetznerToken('t', fakeFetch(401))).toBe('invalid');
    expect(await validateHetznerToken('t', fakeFetch(403))).toBe('invalid');
  });

  it('returns unreachable on an unexpected status', async () => {
    expect(await validateHetznerToken('t', fakeFetch(500))).toBe('unreachable');
  });

  it('returns unreachable when the request throws (offline)', async () => {
    expect(await validateHetznerToken('t', fakeFetch(0, true))).toBe('unreachable');
  });
});
