import type { HarnessAdapter } from '../adapter.js';

// OpenCode has no exec-time config-dir env pin (buildExecEnv's `else` strips the
// foreign keys — the registry fallback preserves that). It reads config-directory
// resources from OPENCODE_CONFIG_DIR, pinned in the generated shim.
export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',

  shimConfigEnvBash() {
    return `
# OpenCode reads plugins, agents, commands, and other config-directory
# resources from OPENCODE_CONFIG_DIR. Point it at the versioned global config
# tree where agents-cli syncs OpenCode resources.
export OPENCODE_CONFIG_DIR="$VERSION_DIR/home/.config/opencode"
`;
  },
};
