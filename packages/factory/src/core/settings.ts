// Settings types and pure functions (no VS Code dependencies - testable)

// Per-agent configuration for built-in agents
export interface BuiltInAgentConfig {
  login: boolean;
  instances: number;
  defaultModel?: string;
}

// Custom agent configuration
export interface CustomAgentConfig {
  name: string;
  command: string;
  login: boolean;
  instances: number;
}

// Command alias for built-in agents with custom flags
// e.g., "Fast" alias for Claude with "--model claude-haiku-4-5-20251001"
export interface CommandAlias {
  name: string;           // Display name (e.g., "Fast", "Max Context")
  agent: string;          // Built-in agent key: "claude" | "codex" | "gemini" | etc.
  flags: string;          // Additional CLI flags (e.g., "--model claude-haiku-4-5-20251001")
}

// Quick launch slot for keyboard shortcuts (Cmd+Shift+0..9)
export interface QuickLaunchSlot {
  agent: string;          // Built-in agent key: "claude" | "codex" | "gemini" | etc.
  version?: string;       // Pinned agents-cli version (e.g., "1.2.6"); empty = default
  mode?: 'plan' | 'edit'; // CLI --mode; omit to use agent default
  model?: string;         // Concrete model id (e.g., "claude-opus-4-7-20260115")
  modelAlias?: string;    // Agents-cli alias (e.g., "opus", "haiku") — resolved to a concrete id on first launch
  extraFlags?: string;    // Free-form CLI flags appended last (e.g., "--reasoning high")
  label?: string;         // Display label for dashboard
}

// Quick launch slots configuration. New shape uses `slots` keyed by digit "0".."9".
// `slot1/slot2/slot3` are legacy fields kept for backwards compat with persisted state.
export interface QuickLaunchConfig {
  slots?: Record<string, QuickLaunchSlot>;
  slot1?: QuickLaunchSlot;
  slot2?: QuickLaunchSlot;
  slot3?: QuickLaunchSlot;
}

export const QUICK_LAUNCH_SLOT_KEYS = ['0','1','2','3','4','5','6','7','8','9'] as const;
export type QuickLaunchSlotKey = typeof QUICK_LAUNCH_SLOT_KEYS[number];

export function getQuickLaunchSlot(config: QuickLaunchConfig | undefined, key: QuickLaunchSlotKey): QuickLaunchSlot | undefined {
  if (!config) return undefined;
  const direct = config.slots?.[key];
  if (direct) return direct;
  // Legacy fallback for slot1/slot2/slot3 only.
  if (key === '1') return config.slot1;
  if (key === '2') return config.slot2;
  if (key === '3') return config.slot3;
  return undefined;
}

export function setQuickLaunchSlot(
  config: QuickLaunchConfig | undefined,
  key: QuickLaunchSlotKey,
  slot: QuickLaunchSlot | undefined,
): QuickLaunchConfig {
  const next: QuickLaunchConfig = {
    ...(config || {}),
    slots: { ...(config?.slots || {}) },
  };
  // Strip legacy mirror — slots map is the source of truth going forward.
  delete next.slot1;
  delete next.slot2;
  delete next.slot3;
  if (slot) {
    next.slots![key] = slot;
  } else {
    delete next.slots![key];
  }
  return next;
}

// One-shot migration: fold legacy slot1/slot2/slot3 into the `slots` map.
export function migrateLegacyQuickLaunchSlots(config: QuickLaunchConfig): boolean {
  let changed = false;
  if (!config.slots) {
    config.slots = {};
  }
  if (config.slot1 && !config.slots['1']) { config.slots['1'] = config.slot1; changed = true; }
  if (config.slot2 && !config.slots['2']) { config.slots['2'] = config.slot2; changed = true; }
  if (config.slot3 && !config.slots['3']) { config.slots['3'] = config.slot3; changed = true; }
  if (config.slot1 || config.slot2 || config.slot3) {
    delete config.slot1;
    delete config.slot2;
    delete config.slot3;
    changed = true;
  }
  return changed;
}

// Prompt entry for saving reusable prompts
export interface PromptEntry {
  id: string;
  title: string;
  content: string;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
  accessedAt: number;  // Last time prompt was used (for sorting by recency)
}

// Swarm agent types (subset of built-in agents that support swarm)
export type SwarmAgentType = 'claude' | 'codex' | 'gemini';
export const ALL_SWARM_AGENTS: SwarmAgentType[] = ['claude', 'codex', 'gemini'];

// User-defined mapping from a session cwd to a Factory Floor project group.
// Ordered: the first rule whose pattern matches a session's cwd wins. `pattern`
// is a glob (`**` spans path separators, `*` does not) or a plain path prefix;
// `project` is the display name cards group under. Consumed by resolveProject in
// remoteSessions.ts (mirrored in ui/.../floorModel.ts across the webview boundary).
export interface ProjectRule {
  pattern: string;
  project: string;
}

// Full agent settings structure
export interface AgentSettings {
  builtIn: {
    claude: BuiltInAgentConfig;
    codex: BuiltInAgentConfig;
    gemini: BuiltInAgentConfig;
    opencode: BuiltInAgentConfig;
    cursor: BuiltInAgentConfig;
    shell: BuiltInAgentConfig;
  };
  custom: CustomAgentConfig[];
  aliases: CommandAlias[];
  quickLaunch?: QuickLaunchConfig;  // Quick launch slots for Cmd+Shift+1/2/3
  swarmEnabledAgents: SwarmAgentType[];
  prompts: PromptEntry[];
  editor: EditorPreferences;
  display: DisplayPreferences;
  notifications?: NotificationSettings;
  showWelcomeScreen: boolean;       // Open dashboard on VS Code startup
  taskSources: TaskSourceSettings;  // Task sources for Tasks tab
  githubOwner?: string;             // Default GitHub owner for cloud dispatch (e.g. "muqsitnawaz")
  projectRules?: ProjectRule[];     // Ordered cwd->project mappings for Factory Floor grouping
}

export interface EditorPreferences {
  markdownViewerEnabled: boolean;
}

// Display preferences for terminal titles and labels
export interface DisplayPreferences {
  showFullAgentNames: boolean;
  showLabelsInTitles: boolean;
  autoLabelInTabTitles: boolean;  // true = auto-label tab titles from first user message
  showSessionIdInTitles: boolean;
  labelReplacesTitle: boolean;  // true = label replaces title, false = append with dash
  showLabelOnlyOnFocus: boolean;  // true = hide label when terminal loses focus
}

export interface NotificationSettings {
  enabled: boolean;
  style: 'native' | 'vscode';
  enabledAgents: string[];
}

// Task source settings for multi-source Tasks tab
export type TaskSource = 'linear' | 'github';

export interface TaskSourceSettings {
  linear: boolean;    // default: false (auto-enable if Linear MCP detected)
  github: boolean;    // default: false (auto-enable if GitHub MCP detected)
  githubAssignedOnly: boolean; // default: false (show all open issues, not just @me)
}

export const DEFAULT_TASK_SOURCE_SETTINGS: TaskSourceSettings = {
  linear: true,
  github: true,
  githubAssignedOnly: false
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  style: 'native',
  enabledAgents: ['claude']
};

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  showFullAgentNames: true,
  showLabelsInTitles: true,
  autoLabelInTabTitles: true,
  showSessionIdInTitles: true,
  labelReplacesTitle: false,  // Default: append label (e.g., "Claude - label")
  showLabelOnlyOnFocus: false  // Default: always show label
};

export const AGENT_MODELS: Record<string, string[]> = {
  claude: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'],
  codex: ['gpt-5.2-codex', 'gpt-5.1-codex-max'],
  gemini: ['gemini-3-flash', 'gemini-3-pro'],
  cursor: ['composer-1'],
  opencode: [],
  shell: []
};

export const DEFAULT_QUICK_LAUNCH: QuickLaunchConfig = {
  slots: {
    '1': { agent: 'claude', modelAlias: 'opus', label: 'Claude Opus' },
    '2': { agent: 'claude', modelAlias: 'haiku', label: 'Claude Haiku' },
  },
};

// Model ids shipped as hardcoded defaults in earlier extension versions.
// Map them to aliases so agents-cli can resolve the current concrete model on launch.
const STALE_CLAUDE_MODEL_TO_ALIAS: Record<string, string> = {
  'claude-opus-4-5': 'opus',
  'claude-sonnet-4-5': 'sonnet',
  'claude-haiku-4-5': 'haiku',
};

function migrateStaleSlot(slot: QuickLaunchSlot | undefined): boolean {
  if (!slot || slot.agent !== 'claude' || !slot.model) return false;
  const alias = STALE_CLAUDE_MODEL_TO_ALIAS[slot.model];
  if (!alias) return false;
  slot.model = undefined;
  slot.modelAlias = alias;
  return true;
}

export function migrateStaleClaudeQuickLaunch(quickLaunch: QuickLaunchConfig): boolean {
  let changed = false;
  if (migrateStaleSlot(quickLaunch.slot1)) changed = true;
  if (migrateStaleSlot(quickLaunch.slot2)) changed = true;
  if (migrateStaleSlot(quickLaunch.slot3)) changed = true;
  if (quickLaunch.slots) {
    for (const k of Object.keys(quickLaunch.slots)) {
      if (migrateStaleSlot(quickLaunch.slots[k])) changed = true;
    }
  }
  return changed;
}

// Default settings (pure function)
export function getDefaultSettings(): AgentSettings {
  return {
    builtIn: {
      claude: { login: false, instances: 2 },
      codex: { login: false, instances: 2 },
      gemini: { login: false, instances: 2 },
      opencode: { login: false, instances: 2 },
      cursor: { login: false, instances: 2 },
      shell: { login: false, instances: 1 }
    },
    custom: [],
    aliases: [],
    quickLaunch: { ...DEFAULT_QUICK_LAUNCH },
    swarmEnabledAgents: [...ALL_SWARM_AGENTS],
    prompts: [],
    editor: { markdownViewerEnabled: true },
    display: { ...DEFAULT_DISPLAY_PREFERENCES },
    notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
    showWelcomeScreen: true,
    taskSources: { ...DEFAULT_TASK_SOURCE_SETTINGS },
    projectRules: []
  };
}

// Check if any agents have login enabled (pure function)
export function hasLoginEnabled(settings: AgentSettings): boolean {
  return (
    Object.values(settings.builtIn).some(a => a.login) ||
    settings.custom.some(a => a.login)
  );
}
