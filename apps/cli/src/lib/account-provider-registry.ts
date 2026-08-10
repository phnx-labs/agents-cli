import type { AgentId } from './types.js';

export type AccountAuthKind = 'api-key' | 'setup-token' | 'bearer-token';

export interface AccountProviderAdapter {
  provider: string;
  authKinds: readonly AccountAuthKind[];
  envFor(host: AgentId, kind: AccountAuthKind): string;
  connectionEnvFor(host: AgentId): Record<string, string>;
  validate(kind: AccountAuthKind, value: string): void;
}

const nonEmpty = (provider: string, kind: AccountAuthKind, value: string): void => {
  if (!value.trim()) throw new Error(`${provider} ${kind} cannot be empty.`);
};

function fixed(
  provider: string,
  authKinds: readonly AccountAuthKind[],
  envByHost: Partial<Record<AgentId, string>>,
  connectionEnvByHost: Partial<Record<AgentId, Record<string, string>>> = {},
  validate?: (kind: AccountAuthKind, value: string) => void,
): AccountProviderAdapter {
  return {
    provider,
    authKinds,
    envFor(host, kind) {
      if (!authKinds.includes(kind)) throw new Error(`Provider '${provider}' does not support ${kind} accounts.`);
      const env = envByHost[host];
      if (!env) throw new Error(`Provider '${provider}' cannot authenticate the ${host} harness.`);
      return env;
    },
    connectionEnvFor(host) {
      return connectionEnvByHost[host] ?? {};
    },
    validate(kind, value) {
      nonEmpty(provider, kind, value);
      validate?.(kind, value);
    },
  };
}

const ADAPTERS = new Map<string, AccountProviderAdapter>([
  ['anthropic', fixed('anthropic', ['api-key', 'setup-token'], { claude: 'ANTHROPIC_API_KEY' }, {}, (kind, value) => {
    if (kind === 'setup-token' && !value.startsWith('sk-ant-oat01-')) {
      throw new Error('Anthropic setup tokens must start with sk-ant-oat01-.');
    }
  })],
  ['cursor', fixed('cursor', ['api-key'], { cursor: 'CURSOR_API_KEY' })],
  ['openrouter', fixed(
    'openrouter',
    ['api-key'],
    { claude: 'ANTHROPIC_AUTH_TOKEN', codex: 'OPENAI_API_KEY', opencode: 'OPENROUTER_API_KEY' },
    { claude: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' }, codex: { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' } },
  )],
  ['openai', fixed('openai', ['api-key'], { codex: 'OPENAI_API_KEY', opencode: 'OPENAI_API_KEY' })],
  ['xai', fixed('xai', ['api-key'], { grok: 'XAI_API_KEY', claude: 'ANTHROPIC_AUTH_TOKEN' })],
  ['google', fixed('google', ['api-key'], { gemini: 'GEMINI_API_KEY', antigravity: 'ANTIGRAVITY_API_KEY' })],
  ['opencode', fixed('opencode', ['api-key'], { opencode: 'OPENCODE_API_KEY' })],
  ['proxy', fixed('proxy', ['api-key', 'bearer-token'], { claude: 'ANTHROPIC_AUTH_TOKEN', codex: 'OPENAI_API_KEY' })],
  ['truefoundry', fixed('truefoundry', ['api-key', 'bearer-token'], { claude: 'ANTHROPIC_AUTH_TOKEN' })],
  ['bedrock', fixed('bedrock', ['bearer-token'], { claude: 'AWS_BEARER_TOKEN_BEDROCK' })],
  ['foundry', fixed('foundry', ['api-key'], { claude: 'ANTHROPIC_FOUNDRY_API_KEY' })],
  ['litellm', fixed('litellm', ['api-key', 'bearer-token'], { claude: 'ANTHROPIC_AUTH_TOKEN', codex: 'OPENAI_API_KEY' })],
  ['vllm', fixed('vllm', ['api-key', 'bearer-token'], { claude: 'ANTHROPIC_AUTH_TOKEN', codex: 'OPENAI_API_KEY' })],
  ['ollama', fixed('ollama', ['api-key'], { codex: 'OPENAI_API_KEY' })],
]);

export function getAccountProvider(provider: string): AccountProviderAdapter {
  const adapter = ADAPTERS.get(provider.toLowerCase());
  if (!adapter) throw new Error(`Unknown account provider '${provider}'. Supported: ${listAccountProviders().join(', ')}.`);
  return adapter;
}

export function listAccountProviders(): string[] {
  return [...ADAPTERS.keys()].sort();
}
