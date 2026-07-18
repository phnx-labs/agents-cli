import { describe, it, expect } from 'vitest';

import {
  CONFIG_ENV_ISOLATED_AGENTS,
  supportsIsolatedInstall,
  generateVersionedAliasScript,
} from '../shims.js';
import { ALL_AGENT_IDS } from '../agents.js';
import type { AgentId } from '../types.js';

// The env var each isolation-capable agent's versioned alias must export to
// redirect the copy's config away from the user's real ~/.<agent>. This is the
// contract that makes `agents add --isolated` safe for these agents.
const CONFIG_ENV_BY_AGENT: Record<(typeof CONFIG_ENV_ISOLATED_AGENTS)[number], string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME',
  grok: 'GROK_HOME',
  kimi: 'KIMI_CODE_HOME',
};
const ALL_CONFIG_ENVS = Object.values(CONFIG_ENV_BY_AGENT);

// A version string that passes assertSafeVersion.
const V = '1.0.0';

describe('isolated-install capability', () => {
  it('supportsIsolatedInstall matches the CONFIG_ENV_ISOLATED_AGENTS set', () => {
    for (const agent of ALL_AGENT_IDS) {
      expect(supportsIsolatedInstall(agent)).toBe(CONFIG_ENV_ISOLATED_AGENTS.includes(agent));
    }
  });

  it('every isolation-capable agent exports its config-dir env var in the versioned alias', () => {
    for (const agent of CONFIG_ENV_ISOLATED_AGENTS) {
      const script = generateVersionedAliasScript(agent, V);
      expect(script).toContain(`export ${CONFIG_ENV_BY_AGENT[agent]}=`);
    }
  });

  // The load-bearing coupling test: if someone adds (or removes) a config-dir
  // env var in generateVersionedAliasScript without updating the capability
  // list, the two drift and --isolated would either over- or under-promise.
  // This locks them together: an agent emits a config-dir env export IFF it is
  // declared isolation-capable.
  it('the alias generator and the capability list stay in sync', () => {
    for (const agent of ALL_AGENT_IDS) {
      const script = generateVersionedAliasScript(agent, V);
      const emitsConfigEnv = ALL_CONFIG_ENVS.some((env) => script.includes(`export ${env}=`));
      expect(emitsConfigEnv).toBe(supportsIsolatedInstall(agent));
    }
  });

  it('agents without an env var export none in the versioned alias', () => {
    const unsupported: AgentId[] = ALL_AGENT_IDS.filter((a) => !supportsIsolatedInstall(a));
    for (const agent of unsupported) {
      const script = generateVersionedAliasScript(agent, V);
      for (const env of ALL_CONFIG_ENVS) {
        expect(script).not.toContain(`export ${env}=`);
      }
    }
  });
});
