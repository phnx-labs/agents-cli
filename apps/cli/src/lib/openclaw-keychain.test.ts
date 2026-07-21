import { describe, expect, it } from 'vitest';
import {
  migrateOpenClawConfigToKeychainRefs,
  resolveOpenClawKeychainRequest,
} from './openclaw-keychain.js';

describe('migrateOpenClawConfigToKeychainRefs', () => {
  it('moves supported OpenClaw MCP env secrets to exec SecretRefs and removes plaintext env', () => {
    const config: Record<string, unknown> = {
      env: {
        LINEAR_API_KEY: 'lin_secret',
        vars: {
          GRAFANA_API_KEY: 'grafana_secret',
        },
      },
      plugins: {
        entries: {
          acpx: {
            config: {
              mcpServers: {
                linear: {
                  command: 'node',
                  env: { LINEAR_API_KEY: 'lin_secret' },
                },
                grafana: {
                  command: 'node',
                  env: { GRAFANA_API_KEY: 'grafana_secret' },
                },
              },
            },
          },
        },
      },
    };

    const result = migrateOpenClawConfigToKeychainRefs(config, {
      account: 'openclaw',
      agentsBin: '/usr/local/bin/agents',
    });

    expect(result.services.map((s) => [s.envKey, s.service, s.value])).toEqual([
      ['LINEAR_API_KEY', 'linear-api-key', 'lin_secret'],
      ['GRAFANA_API_KEY', 'grafana-api-key', 'grafana_secret'],
    ]);
    expect(result.replacedPaths).toEqual([
      'plugins.entries.acpx.config.mcpServers.linear.env.LINEAR_API_KEY',
      'plugins.entries.acpx.config.mcpServers.grafana.env.GRAFANA_API_KEY',
    ]);
    expect(result.removedEnvPaths).toEqual(['env.LINEAR_API_KEY', 'env.vars.GRAFANA_API_KEY']);
    expect(result.unsupportedEnvKeys).toEqual([]);
    expect(config).toMatchObject({
      env: { vars: {} },
      secrets: {
        providers: {
          agents_keychain: {
            source: 'exec',
            jsonOnly: true,
          },
        },
      },
      plugins: {
        entries: {
          acpx: {
            config: {
              mcpServers: {
                linear: {
                  env: {
                    LINEAR_API_KEY: { source: 'exec', provider: 'agents_keychain', id: 'linear-api-key' },
                  },
                },
                grafana: {
                  env: {
                    GRAFANA_API_KEY: { source: 'exec', provider: 'agents_keychain', id: 'grafana-api-key' },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it('maps OpenRouter model apiKey to Keychain when the provider key matches the top-level env value', () => {
    const config: Record<string, unknown> = {
      env: { OPENROUTER_API_KEY: 'sk-or-secret' },
      models: {
        providers: {
          openrouter: { apiKey: 'sk-or-secret' },
        },
      },
    };

    const result = migrateOpenClawConfigToKeychainRefs(config, {
      account: 'openclaw',
      agentsBin: '/usr/local/bin/agents',
    });

    expect(result.services).toEqual([
      { envKey: 'OPENROUTER_API_KEY', service: 'openrouter-api-key', value: 'sk-or-secret' },
    ]);
    expect(result.replacedPaths).toEqual(['models.providers.openrouter.apiKey']);
    expect(result.removedEnvPaths).toEqual(['env.OPENROUTER_API_KEY']);
    expect(config.models).toEqual({
      providers: {
        openrouter: {
          apiKey: { source: 'exec', provider: 'agents_keychain', id: 'openrouter-api-key' },
        },
      },
    });
  });

  it('reports top-level env secrets that have no supported SecretRef target', () => {
    const config: Record<string, unknown> = {
      env: { POSTHOG_API_KEY: 'ph_secret' },
    };

    const result = migrateOpenClawConfigToKeychainRefs(config, {
      account: 'openclaw',
      agentsBin: '/usr/local/bin/agents',
    });

    expect(result.services).toEqual([]);
    expect(result.unsupportedEnvKeys).toEqual(['POSTHOG_API_KEY']);
    expect(config).toEqual({ env: { POSTHOG_API_KEY: 'ph_secret' } });
  });
});

describe('resolveOpenClawKeychainRequest', () => {
  it('returns OpenClaw exec-provider protocol values and per-id errors', () => {
    const response = resolveOpenClawKeychainRequest(
      { protocolVersion: 1, provider: 'agents_keychain', ids: ['linear-api-key', 'missing'] },
      (id) => {
        if (id === 'linear-api-key') return 'lin_secret';
        throw new Error('missing');
      },
    );

    expect(response).toEqual({
      protocolVersion: 1,
      values: { 'linear-api-key': 'lin_secret' },
      errors: { missing: { code: 'NOT_FOUND' } },
    });
  });
});
