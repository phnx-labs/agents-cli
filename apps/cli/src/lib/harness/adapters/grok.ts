import type { HarnessAdapter } from '../adapter.js';

// Grok has no exec-time config-dir env pin (buildExecEnv's `else` strips the
// foreign keys — the registry fallback preserves that). It DOES relocate its
// whole config tree via GROK_HOME in the generated shim.
export const grokAdapter: HarnessAdapter = {
  id: 'grok',

  shimConfigEnvBash() {
    return `
# Grok Build uses GROK_HOME to isolate its entire configuration tree
# (skills, hooks, plugins, agents, memory, sessions, config.toml, MCP, etc.).
# This gives agents-cli full versioned isolation + resource sync for grok.
export GROK_HOME="$VERSION_DIR/home/.grok"
`;
  },
};
