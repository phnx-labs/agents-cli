import { describe, expect, it } from 'vitest';
import { expandPreset, getPreset, listProviders } from './profiles-presets.js';

describe('profiles-presets', () => {
  it('truefoundry preset carries Bedrock-strict-validation env vars', () => {
    const p = getPreset('truefoundry');
    expect(p).toBeDefined();
    expect(p!.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    expect(p!.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(p!.env.DISABLE_PROMPT_CACHING).toBe('1');
  });

  it('foundry preset is Microsoft Azure AI Foundry on claude host', () => {
    const p = getPreset('foundry');
    expect(p).toBeDefined();
    expect(p!.host).toBe('claude');
    expect(p!.provider).toBe('foundry');
  });

  it('ollama preset uses codex host (not claude)', () => {
    const p = getPreset('ollama');
    expect(p).toBeDefined();
    expect(p!.host).toBe('codex');
  });

  it('expandPreset(truefoundry) returns two prompts', () => {
    const p = getPreset('truefoundry')!;
    expect(expandPreset(p).prompts).toHaveLength(2);
  });

  it('expandPreset(kimi) returns zero prompts (existing presets unchanged)', () => {
    const p = getPreset('kimi')!;
    expect(expandPreset(p).prompts).toHaveLength(0);
  });

  it('listProviders() includes all new gateway providers', () => {
    const providers = listProviders();
    for (const name of [
      'truefoundry',
      'bedrock',
      'vertex',
      'foundry',
      'litellm',
      'vllm',
      'ollama',
      'anthropic',
      'proxy',
    ]) {
      expect(providers).toContain(name);
    }
  });

  it('bedrock and proxy presets are authOptional', () => {
    expect(getPreset('bedrock')?.authOptional).toBe(true);
    expect(getPreset('proxy')?.authOptional).toBe(true);
  });

  it('grok presets have verified 2026 model IDs', () => {
    expect(getPreset('grok-fast')?.env.GROK_MODEL).toBe('grok-build-0.1');
    expect(getPreset('grok-heavy')?.env.GROK_MODEL).toBe('grok-4.3');
  });

  it('proxy preset is on claude host with two prompts', () => {
    const p = getPreset('proxy')!;
    expect(p.host).toBe('claude');
    expect(expandPreset(p).prompts).toHaveLength(2);
  });
});
