import { describe, it, expect } from 'vitest';
import { resolveProvider, nativeProviderForAgent } from './registry.js';

describe('nativeProviderForAgent', () => {
  it('maps the four agents to their own cloud', () => {
    expect(nativeProviderForAgent('claude')).toBe('rush');
    expect(nativeProviderForAgent('codex')).toBe('codex');
    expect(nativeProviderForAgent('droid')).toBe('factory');
    expect(nativeProviderForAgent('antigravity')).toBe('antigravity');
  });

  it('returns undefined for agents with no native cloud', () => {
    expect(nativeProviderForAgent('gemini')).toBeUndefined();
    expect(nativeProviderForAgent('cursor')).toBeUndefined();
    expect(nativeProviderForAgent('not-an-agent')).toBeUndefined();
  });
});

describe('resolveProvider precedence', () => {
  it('routes an agent to its native cloud when no provider is given', () => {
    expect(resolveProvider(undefined, 'codex').id).toBe('codex');
    expect(resolveProvider(undefined, 'droid').id).toBe('factory');
    expect(resolveProvider(undefined, 'antigravity').id).toBe('antigravity');
    expect(resolveProvider(undefined, 'claude').id).toBe('rush');
  });

  it('lets an explicit --provider override the agent', () => {
    expect(resolveProvider('codex', 'droid').id).toBe('codex');
    expect(resolveProvider('rush', 'codex').id).toBe('rush');
  });

  it('falls back to the default (rush) for an agent with no native cloud', () => {
    expect(resolveProvider(undefined, 'gemini').id).toBe('rush');
  });

  it('falls back to the default (rush) when neither provider nor agent is given', () => {
    expect(resolveProvider().id).toBe('rush');
  });
});
