import { describe, expect, it } from 'vitest';
import {
  extractShareHttpError,
  formatShareHttpErrorDetail,
  MAX_ERROR_BODY_BYTES,
  MAX_ERROR_MESSAGE_CHARS,
} from './http-error.js';

describe('extractShareHttpError — surfaces the real server error, bounded', () => {
  it('lifts the JSON `error` field from a 400', () => {
    const err = extractShareHttpError({ status: 400, body: '{"error":"visibility org requires a verified email domain"}' });
    expect(err.status).toBe(400);
    expect(err.serverMessage).toBe('visibility org requires a verified email domain');
    expect(err.retryAfter).toBeUndefined();
  });

  it('preserves status + message for a 413 over-quota', () => {
    const err = extractShareHttpError({ status: 413, body: '{"error":"file exceeds the 5MB per-file cap"}' });
    expect(err.status).toBe(413);
    expect(err.serverMessage).toBe('file exceeds the 5MB per-file cap');
  });

  it('keeps the Retry-After alongside the message on a 429', () => {
    const err = extractShareHttpError({ status: 429, body: '{"error":"publish rate limit exceeded"}', retryAfter: '37' });
    expect(err.status).toBe(429);
    expect(err.serverMessage).toBe('publish rate limit exceeded');
    expect(err.retryAfter).toBe('37');
  });

  it('never surfaces an arbitrary non-JSON body (an HTML error page)', () => {
    const err = extractShareHttpError({ status: 502, body: '<html><body>Bad Gateway</body></html>' });
    expect(err.status).toBe(502);
    expect(err.serverMessage).toBeUndefined();
  });

  it('ignores an oversized body rather than parsing it', () => {
    const huge = '{"error":"' + 'x'.repeat(MAX_ERROR_BODY_BYTES + 100) + '"}';
    expect(huge.length).toBeGreaterThan(MAX_ERROR_BODY_BYTES);
    const err = extractShareHttpError({ status: 500, body: huge });
    expect(err.serverMessage).toBeUndefined();
  });

  it('caps a pathologically long (but valid) error message', () => {
    const long = 'e'.repeat(MAX_ERROR_MESSAGE_CHARS + 500);
    const err = extractShareHttpError({ status: 400, body: JSON.stringify({ error: long }) });
    expect(err.serverMessage?.length).toBe(MAX_ERROR_MESSAGE_CHARS);
  });

  it('ignores a non-string error field and a JSON array', () => {
    expect(extractShareHttpError({ status: 400, body: '{"error":{"code":1}}' }).serverMessage).toBeUndefined();
    expect(extractShareHttpError({ status: 400, body: '["nope"]' }).serverMessage).toBeUndefined();
  });

  it('handles a missing body (no message, status preserved)', () => {
    const err = extractShareHttpError({ status: 403 });
    expect(err.status).toBe(403);
    expect(err.serverMessage).toBeUndefined();
  });
});

describe('formatShareHttpErrorDetail — the one-line suffix', () => {
  it('joins message and retry-after', () => {
    expect(
      formatShareHttpErrorDetail({ status: 429, serverMessage: 'rate limit exceeded', retryAfter: '37' }),
    ).toBe(' — rate limit exceeded; retry after 37s');
  });

  it('is empty when nothing was extractable', () => {
    expect(formatShareHttpErrorDetail({ status: 500 })).toBe('');
  });

  it('message alone, no retry-after', () => {
    expect(formatShareHttpErrorDetail({ status: 400, serverMessage: 'bad request' })).toBe(' — bad request');
  });
});
