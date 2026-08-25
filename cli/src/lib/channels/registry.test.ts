import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerChannelProvider,
  resolveChannelProvider,
  listChannelProviders,
  type ChannelProvider,
} from './registry.js';

const stub = (name: string): ChannelProvider => ({
  name,
  async send() {
    return { ok: true, channel: name, id: 'x' };
  },
});

describe('channel registry', () => {
  it('registers and resolves a provider by name', () => {
    registerChannelProvider(stub('reg-test-a'));
    expect(resolveChannelProvider('reg-test-a')?.name).toBe('reg-test-a');
  });

  it('returns undefined for an unregistered provider', () => {
    expect(resolveChannelProvider('reg-test-nope')).toBeUndefined();
  });

  it('lists registered providers sorted', () => {
    registerChannelProvider(stub('reg-test-z'));
    registerChannelProvider(stub('reg-test-m'));
    const names = listChannelProviders().filter((n) => n.startsWith('reg-test-'));
    expect(names).toEqual([...names].sort());
    expect(names).toContain('reg-test-m');
    expect(names).toContain('reg-test-z');
  });
});
