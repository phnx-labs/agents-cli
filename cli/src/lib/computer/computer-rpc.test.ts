import { afterEach, describe, expect, it } from 'vitest';
import { describeTransport, resolveTcpEndpoint } from './computer-rpc.js';

// Snapshot + restore the two env vars the TCP transport reads so tests don't
// leak into each other (or into the rest of the suite).
const SAVED = {
  tcp: process.env.COMPUTER_HELPER_TCP,
  token: process.env.COMPUTER_HELPER_TOKEN,
};
afterEach(() => {
  if (SAVED.tcp === undefined) delete process.env.COMPUTER_HELPER_TCP;
  else process.env.COMPUTER_HELPER_TCP = SAVED.tcp;
  if (SAVED.token === undefined) delete process.env.COMPUTER_HELPER_TOKEN;
  else process.env.COMPUTER_HELPER_TOKEN = SAVED.token;
});

describe('resolveTcpEndpoint', () => {
  it('is null when COMPUTER_HELPER_TCP is unset', () => {
    delete process.env.COMPUTER_HELPER_TCP;
    expect(resolveTcpEndpoint()).toBeNull();
  });

  it('parses host:port and defaults the host to loopback for a bare port', () => {
    process.env.COMPUTER_HELPER_TCP = '9999';
    delete process.env.COMPUTER_HELPER_TOKEN;
    expect(resolveTcpEndpoint()).toEqual({ host: '127.0.0.1', port: 9999, token: null });

    process.env.COMPUTER_HELPER_TCP = '10.0.0.4:8765';
    process.env.COMPUTER_HELPER_TOKEN = 'sekret';
    expect(resolveTcpEndpoint()).toEqual({ host: '10.0.0.4', port: 8765, token: 'sekret' });
  });

  it('rejects a non-numeric / non-positive port', () => {
    process.env.COMPUTER_HELPER_TCP = 'localhost:notaport';
    expect(resolveTcpEndpoint()).toBeNull();
  });
});

describe('describeTransport', () => {
  it('reports the tcp transport when COMPUTER_HELPER_TCP is set', () => {
    // This is exactly what withClient() guards on: kind !== 'none' means it
    // opens the client instead of exiting with "helper not built". Setting the
    // env var must flip the transport to tcp even off macOS (no socket, no .app).
    process.env.COMPUTER_HELPER_TCP = '127.0.0.1:8765';
    const t = describeTransport();
    expect(t.kind).toBe('tcp');
    expect(t.kind).not.toBe('none');
    expect(t.path).toBeNull();
  });

  it('TCP takes precedence over every other transport', () => {
    // Even if a local socket/app existed, an explicit endpoint wins — mirrors
    // openComputerClient()'s precedence so status and driving agree.
    process.env.COMPUTER_HELPER_TCP = '127.0.0.1:8765';
    expect(describeTransport().kind).toBe('tcp');
  });
});
