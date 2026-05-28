/**
 * Built-in profile presets for popular model providers.
 *
 * Each preset bundles a host CLI, API base URL, default model, and provider
 * name so users can `agents profiles add kimi` without manual configuration.
 */

import type { AgentId } from './types.js';

/** A pre-configured profile template for a model provider. */
export interface Preset {
  name: string;
  description: string;
  provider: string;
  host: AgentId;
  env: Record<string, string>;
  authEnvVar: string;
  signupUrl?: string;
}

// Model IDs verified against openrouter.ai/api/v1/models on 2026-04-20.
// Presets target the top-ranked open-source model per provider based on
// SWE-bench Verified, LiveCodeBench, HumanEval, and Chatbot Arena rankings.
//
// Important limitation of Claude Code + non-Anthropic models via OpenRouter:
// Claude Code sends `thinking:{type:"enabled"}` in its Anthropic payload by
// default, and its `--print` consolidation returns empty text when a response
// contains thinking/redacted_thinking blocks — even when the model *also*
// emits a text block. This means reasoning models work fine in interactive
// `claude` mode (same env vars) but `agents run <profile> --print` sees
// empty stdout.
//
// Presets flagged "print-safe" use non-reasoning variants that ignore
// thinking:enabled. Presets flagged "reasoning" are the leaderboard leaders
// but are best invoked interactively.

const OPENROUTER_BASE = 'https://openrouter.ai/api';
const OPENROUTER_AUTH: Pick<Preset, 'provider' | 'host' | 'authEnvVar' | 'signupUrl'> = {
  provider: 'openrouter',
  host: 'claude',
  authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
  signupUrl: 'https://openrouter.ai/keys',
};

export const PRESETS: Preset[] = [
  // ----- Top coding (via OpenRouter) -----
  {
    name: 'kimi',
    description: 'Kimi K2.5 via OpenRouter (262K ctx, $0.38/$1.72 per 1M). Top Kimi: 99% HumanEval, 76.8% SWE-bench. REASONING — works interactively, but `agents run --print` returns empty stdout. Use `kimi-chat` preset for scripting.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
      ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2.5',
    },
  },
  {
    name: 'kimi-chat',
    description: 'Kimi K2 0905 via OpenRouter (262K ctx, $0.40/$2.00 per 1M). Non-reasoning sibling of K2.5 — slightly older but PRINT-SAFE, works end-to-end with `agents run --print` and in scripts/automation.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2-0905',
      ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2-0905',
    },
  },
  {
    name: 'minimax',
    description: 'MiniMax M2.5 via OpenRouter (230B params). #1 SWE-bench Verified (80.2%) on Apr 2026 leaderboards. REASONING — works interactively, --print returns empty.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'minimax/minimax-m2.5',
      ANTHROPIC_SMALL_FAST_MODEL: 'minimax/minimax-m2.5',
    },
  },
  {
    name: 'glm',
    description: 'GLM 5 via OpenRouter (80K ctx, $0.72/$2.30 per 1M). #1 Chatbot Arena ELO (1451) among open-weight models on BenchLM.ai (Apr 2026). Prompt-complexity-dependent reasoning — Claude Code\'s 38K system prompt typically triggers thinking blocks, so --print is unreliable. Interactive use is fine.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'z-ai/glm-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'z-ai/glm-5',
    },
  },
  {
    name: 'qwen',
    description: 'Qwen3 Coder Next via OpenRouter (256K ctx, $0.15/$0.80 per 1M, sparse MoE 80B/3B active). Latest coding-specific Qwen (Feb 2026). PRINT-SAFE — works with `agents run --print`.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'qwen/qwen3-coder-next',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen/qwen3-coder-next',
    },
  },
  {
    name: 'deepseek',
    description: 'DeepSeek Chat V3 (0324) via OpenRouter. Latest DeepSeek Chat variant that ignores thinking:enabled. PRINT-SAFE. The newer V3.2 / V3.1-Terminus / V3.2-Speciale are reasoning variants — use `--model deepseek/deepseek-v3.2` to override if you want those for interactive use.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'deepseek/deepseek-chat-v3-0324',
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek/deepseek-chat-v3-0324',
    },
  },
  // ----- xAI Grok Build CLI (native host) -----
  {
    name: 'grok-fast',
    description: 'xAI Grok Build CLI — fast tier. Native grok host, no OpenRouter wrapper.',
    provider: 'xai',
    host: 'grok',
    authEnvVar: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai',
    env: {
      // TODO: confirm model id (docs.x.ai/build/models, May 2026)
      GROK_MODEL: 'grok-build-fast',
    },
  },
  {
    name: 'grok-heavy',
    description: 'xAI Grok Build CLI — heavy tier (SuperGrok). Native grok host.',
    provider: 'xai',
    host: 'grok',
    authEnvVar: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai',
    env: {
      // TODO: confirm model id (docs.x.ai/build/models, May 2026)
      GROK_MODEL: 'grok-build',
    },
  },
  // ----- Google Antigravity CLI (native host) -----
  {
    name: 'agy',
    description: 'Google Antigravity CLI default. Auth via Google OAuth or ANTIGRAVITY_API_KEY.',
    provider: 'google',
    host: 'antigravity',
    authEnvVar: 'ANTIGRAVITY_API_KEY',
    signupUrl: 'https://antigravity.google',
    env: {
      // TODO: confirm model id — antigravity defaults are managed by the CLI itself
    },
  },
];

/** Look up a preset by name (case-sensitive). */
export function getPreset(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}

/** Return a copy of all available presets. */
export function listPresets(): Preset[] {
  return [...PRESETS];
}

/** Return the unique set of provider names across all presets. */
export function listProviders(): string[] {
  return [...new Set(PRESETS.map((p) => p.provider))];
}
