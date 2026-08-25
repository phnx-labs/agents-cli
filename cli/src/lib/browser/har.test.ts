import { describe, it, expect } from 'vitest';
import { buildHar } from './har.js';
import type { NetworkRequest } from './types.js';

describe('buildHar', () => {
  it('produces a HAR 1.2 log with version, creator, one page, and matching entry count', () => {
    const requests: NetworkRequest[] = [
      { id: '1', url: 'https://example.com/', method: 'GET', status: 200, mimeType: 'text/html', timestamp: 1_700_000_000_000 },
      { id: '2', url: 'https://example.com/app.js', method: 'GET', status: 200, mimeType: 'application/javascript', timestamp: 1_700_000_001_000 },
    ];

    const { log } = buildHar(requests, { creatorName: 'agents-cli', creatorVersion: '1.2.3' });

    expect(log.version).toBe('1.2');
    expect(log.creator).toEqual({ name: 'agents-cli', version: '1.2.3' });
    expect(log.pages).toHaveLength(1);
    expect(log.entries).toHaveLength(2);
  });

  it('page.startedDateTime is the earliest request timestamp as ISO 8601', () => {
    const requests: NetworkRequest[] = [
      { id: 'later', url: 'https://a/', method: 'GET', timestamp: 1_700_000_005_000 },
      { id: 'first', url: 'https://a/', method: 'GET', timestamp: 1_700_000_001_000 },
    ];

    const { log } = buildHar(requests);
    expect(log.pages[0].startedDateTime).toBe(new Date(1_700_000_001_000).toISOString());
  });

  it('entry.request preserves method + url and parses queryString from the URL', () => {
    const requests: NetworkRequest[] = [
      { id: '1', url: 'https://example.com/search?q=hello&limit=10', method: 'POST', timestamp: 1_700_000_000_000 },
    ];
    const { log } = buildHar(requests);
    const req = log.entries[0].request;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://example.com/search?q=hello&limit=10');
    expect(req.queryString).toEqual([
      { name: 'q', value: 'hello' },
      { name: 'limit', value: '10' },
    ]);
    expect(req.headers).toEqual([]);
    expect(req.cookies).toEqual([]);
  });

  it('unknown sizes / timings surface as -1 sentinels (spec requirement)', () => {
    const { log } = buildHar([
      { id: '1', url: 'https://a/', method: 'GET', timestamp: 1_700_000_000_000 },
    ]);
    const e = log.entries[0];
    expect(e.time).toBe(-1);
    expect(e.timings).toEqual({ send: -1, wait: -1, receive: -1 });
    expect(e.request.headersSize).toBe(-1);
    expect(e.request.bodySize).toBe(-1);
    expect(e.response.headersSize).toBe(-1);
    expect(e.response.bodySize).toBe(-1);
    expect(e.response.content.size).toBe(-1);
    expect(log.pages[0].pageTimings).toEqual({ onContentLoad: -1, onLoad: -1 });
  });

  it('missing response fields default to status=0 and mimeType=""', () => {
    const { log } = buildHar([
      { id: '1', url: 'https://a/', method: 'GET', timestamp: 1_700_000_000_000 },
    ]);
    expect(log.entries[0].response.status).toBe(0);
    expect(log.entries[0].response.content.mimeType).toBe('');
  });

  it('serializes to JSON that round-trips (validator-friendly shape)', () => {
    const requests: NetworkRequest[] = [
      { id: '1', url: 'https://example.com/', method: 'GET', status: 200, mimeType: 'text/html', timestamp: 1_700_000_000_000 },
    ];
    const json = JSON.stringify(buildHar(requests));
    const parsed = JSON.parse(json);
    expect(parsed.log.version).toBe('1.2');
    expect(parsed.log.entries[0].request.url).toBe('https://example.com/');
  });

  it('empty request buffer still produces a valid single-page HAR log', () => {
    const { log } = buildHar([]);
    expect(log.version).toBe('1.2');
    expect(log.entries).toEqual([]);
    expect(log.pages).toHaveLength(1);
    // startedDateTime must still be a valid ISO string.
    expect(() => new Date(log.pages[0].startedDateTime).toISOString()).not.toThrow();
  });

  it('opaque URLs (data:, malformed) leave queryString empty rather than throwing', () => {
    const { log } = buildHar([
      { id: '1', url: 'data:text/plain,hello', method: 'GET', timestamp: 1_700_000_000_000 },
    ]);
    expect(log.entries[0].request.queryString).toEqual([]);
  });
});
