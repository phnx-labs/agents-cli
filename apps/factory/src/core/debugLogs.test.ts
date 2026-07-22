import { describe, expect, test } from 'bun:test';
import { DebugLogStream } from './debugLogs';

describe('DebugLogStream', () => {
  test('records JSON-RPC request and response rows for a webview message', () => {
    let now = 1000;
    const stream = new DebugLogStream({ now: () => now += 10 });
    const requestId = stream.recordJsonRpcRequest({ type: 'fetchAllTerminals', limit: 10 });
    stream.recordJsonRpcResponse(requestId, 'fetchAllTerminals');

    expect(stream.snapshot()).toEqual([
      {
        id: requestId,
        ts: 1010,
        source: 'jsonrpc',
        direction: 'outgoing',
        method: 'fetchAllTerminals',
        status: 'pending',
        payload: { type: 'fetchAllTerminals', limit: 10 },
      },
      {
        id: `${requestId}:response`,
        ts: 1020,
        source: 'jsonrpc',
        direction: 'incoming',
        method: 'fetchAllTerminals',
        status: 'ok',
      },
    ]);
  });

  test('publishes OAuth step rows to subscribers', () => {
    const stream = new DebugLogStream({ now: () => 2000 });
    const seen: string[] = [];
    const unsubscribe = stream.subscribe((entry) => seen.push(`${entry.source}:${entry.method}:${entry.status}`));

    stream.recordOAuthStep('linear.auth.check', 'pending', { provider: 'linear' });
    stream.recordOAuthStep('linear.auth.check', 'ok', { connected: true });
    unsubscribe();
    stream.recordOAuthStep('github.auth.check', 'ok');

    expect(seen).toEqual([
      'oauth:linear.auth.check:pending',
      'oauth:linear.auth.check:ok',
    ]);
  });

  test('records a JSON-RPC response through subscribers exactly once', () => {
    const stream = new DebugLogStream({ now: () => 3000 });
    const seen: string[] = [];
    const requestId = stream.recordJsonRpcRequest({ type: 'fetchTasks' });
    stream.subscribe((entry) => seen.push(entry.id));

    stream.recordJsonRpcResponse(requestId, 'fetchTasks');

    expect(seen).toEqual([`${requestId}:response`]);
  });

  test('trims to the configured entry limit', () => {
    const stream = new DebugLogStream({ now: () => 1, maxEntries: 2 });
    stream.recordOAuthStep('one', 'ok');
    stream.recordOAuthStep('two', 'ok');
    stream.recordOAuthStep('three', 'ok');

    expect(stream.snapshot().map((entry) => entry.method)).toEqual(['two', 'three']);
  });
});
