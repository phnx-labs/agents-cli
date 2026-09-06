import * as path from 'path';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir } from '../adapter.js';

// OpenCode reads plugins/agents/commands from OPENCODE_CONFIG_DIR and auth from
// $XDG_DATA_HOME/opencode (HARNESS_AUTH.slotEnv). Pin both at the slot / version
// home so two accounts in one install never share a credential (PHNX-3940 T5).
export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',

  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.OPENCODE_CONFIG_DIR = path.join(ctx.versionHome, '.config', 'opencode');
      result.XDG_DATA_HOME = path.join(ctx.versionHome, '.local', 'share');
    }
    stripForeignConfigDir(result, ['OPENCODE_CONFIG_DIR', 'XDG_DATA_HOME']);
  },

  shimConfigEnvBash() {
    return `
# OpenCode reads plugins, agents, commands, and other config-directory
# resources from OPENCODE_CONFIG_DIR. Point it at the versioned global config
# tree where agents-cli syncs OpenCode resources.
export OPENCODE_CONFIG_DIR="$VERSION_DIR/home/.config/opencode"
`;
  },
};
