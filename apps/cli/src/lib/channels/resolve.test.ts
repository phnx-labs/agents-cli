import { describe, expect, it, vi, afterEach } from 'vitest';
import { registerChannelProvider, type ChannelProvider } from './registry.js';
import { resolveTransport } from './resolve.js';
import type { Meta } from '../types.js';

const stub = (name: string): ChannelProvider => ({
  name,
  async send() {
    return { ok: true, channel: name, id: 'x' };
  },
});

// Providers used by these cases.
registerChannelProvider(stub('telegram'));
registerChannelProvider(stub('openclaw-telegram'));
registerChannelProvider(stub('slack'));

const emptyMeta = {} as Meta;

afterEach(() => vi.restoreAllMocks());

describe('resolveTransport', () => {
  it('uses notify.transports mapping when present (telegram -> openclaw-telegram)', () => {
    const meta = { notify: { transports: { telegram: 'openclaw-telegram' } } } as Meta;
    expect(resolveTransport('telegram', meta).name).toBe('openclaw-telegram');
  });

  it('defaults to name-identity when no mapping (channel slack -> provider slack)', () => {
    expect(resolveTransport('slack', emptyMeta).name).toBe('slack');
  });

  it('dies loud on an unregistered provider — never silently reroutes', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => resolveTransport('nonexistent-channel', emptyMeta)).toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalled();
  });
});
