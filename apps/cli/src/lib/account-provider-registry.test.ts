import { describe, expect, it } from 'vitest';
import { PRESETS } from './profiles-presets.js';
import { getAccountProvider } from './account-provider-registry.js';

describe('account provider adapters', () => {
  it('covers every built-in preset that requires a static credential', () => {
    const staticProviders = [...new Set(PRESETS.filter(preset => !preset.authOptional && preset.provider !== 'vertex').map(preset => preset.provider))];
    for (const provider of staticProviders) expect(() => getAccountProvider(provider)).not.toThrow();
  });

  it('fails loud for an incompatible provider and host', () => {
    expect(() => getAccountProvider('cursor').envFor('claude', 'api-key')).toThrow("cannot authenticate the claude harness");
  });

  it('derives the base-url override env from the provider connection env', () => {
    expect(getAccountProvider('openrouter').baseUrlEnvFor('claude')).toBe('ANTHROPIC_BASE_URL');
    expect(getAccountProvider('openrouter').baseUrlEnvFor('codex')).toBe('OPENAI_BASE_URL');
    // A provider with no endpoint env on that host has nothing to override.
    expect(getAccountProvider('cursor').baseUrlEnvFor('cursor')).toBeNull();
  });
});
