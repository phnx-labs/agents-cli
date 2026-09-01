import { describe, expect, it } from 'vitest';
import { SessionsHttpClient } from './net-client.js';

describe('SessionsHttpClient managed path containment', () => {
  it('rejects dot segments before URL normalization can escape the owner prefix', async () => {
    const client = new SessionsHttpClient({ baseUrl: 'https://sessions.test', userId: 'user-a', token: 'token' });
    await expect(client.get('../other-user/session.jsonl')).rejects.toThrow(/Invalid managed sessions object key/);
    await expect(client.get('sessions/./session.jsonl')).rejects.toThrow(/Invalid managed sessions object key/);
  });

  it('rejects an owner id that is not one URL path segment', () => {
    expect(() => new SessionsHttpClient({
      baseUrl: 'https://sessions.test', userId: '../user-a', token: 'token',
    })).toThrow(/Invalid managed sessions user id/);
  });
});
