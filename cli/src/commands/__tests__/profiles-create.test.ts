import { describe, expect, test } from 'vitest';
import { buildProfileFromCollection } from '../profiles.js';
import { getPreset } from '../../lib/profiles-presets.js';

describe('buildProfileFromCollection', () => {
  test('truefoundry preset + collected vars yields profile with Bedrock fixes', () => {
    const tf = getPreset('truefoundry')!;
    const profile = buildProfileFromCollection('yo', tf, {
      ANTHROPIC_BASE_URL: 'https://x.truefoundry.cloud/api/llm',
      ANTHROPIC_MODEL: 'aws/anthropic.claude-sonnet-4-6',
    });
    expect(profile.env.ANTHROPIC_BASE_URL).toBe('https://x.truefoundry.cloud/api/llm');
    expect(profile.env.ANTHROPIC_MODEL).toBe('aws/anthropic.claude-sonnet-4-6');
    expect(profile.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    expect(profile.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(profile.env.DISABLE_PROMPT_CACHING).toBe('1');
    expect(profile.host.agent).toBe('claude');
    expect(profile.preset).toBe('truefoundry');
    expect(profile.provider).toBe('truefoundry');
    expect(profile.auth?.envVar).toBe('ANTHROPIC_AUTH_TOKEN');
  });

  test('ollama preset binds to codex host', () => {
    const o = getPreset('ollama')!;
    const profile = buildProfileFromCollection('local', o, {
      OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
      OPENAI_MODEL: 'qwen3-coder:30b',
    });
    expect(profile.host.agent).toBe('codex');
    expect(profile.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:11434/v1');
    expect(profile.env.OPENAI_MODEL).toBe('qwen3-coder:30b');
    expect(profile.auth?.envVar).toBe('OPENAI_API_KEY');
  });

  test('bedrock preset preserves static env and applies collected region', () => {
    const b = getPreset('bedrock')!;
    const profile = buildProfileFromCollection('br', b, { AWS_REGION: 'us-west-2' });
    expect(profile.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(profile.env.DISABLE_PROMPT_CACHING).toBe('1');
    expect(profile.env.AWS_REGION).toBe('us-west-2');
    expect(profile.auth?.envVar).toBe('AWS_BEARER_TOKEN_BEDROCK');
  });

  test('collected vars override preset static env (user input wins)', () => {
    const tf = getPreset('truefoundry')!;
    const profile = buildProfileFromCollection('yo', tf, {
      DISABLE_PROMPT_CACHING: '0',
      ANTHROPIC_BASE_URL: 'https://x',
      ANTHROPIC_MODEL: 'm',
    });
    expect(profile.env.DISABLE_PROMPT_CACHING).toBe('0');
  });

  test('version is threaded into host.version when provided', () => {
    const tf = getPreset('truefoundry')!;
    const profile = buildProfileFromCollection(
      'yo',
      tf,
      { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_MODEL: 'm' },
      '2.1.143',
    );
    expect(profile.host.version).toBe('2.1.143');
  });
});
