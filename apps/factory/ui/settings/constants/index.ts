import type {
  SwarmAgentType,
  TabId,
  TaskSource,
  NotificationSettings,
  EditorPreferences,
  ThemedIcon,
  BuiltInAgentConfig,
} from '../types'

// All swarm-capable agents
export const ALL_SWARM_AGENTS: SwarmAgentType[] = ['claude', 'codex', 'gemini', 'opencode']

// Default settings
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  style: 'native',
  enabledAgents: ['claude']
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  markdownViewerEnabled: true
}

// Source badges for task sources
export const SOURCE_BADGES: Record<TaskSource, { label: string; color: string }> = {
  linear: { label: 'LN', color: '#5e6ad2' },
  github: { label: 'GH', color: '#238636' }
}

// Reserved agent name prefixes (cannot be used for custom agents)
export const RESERVED_NAMES = ['CC', 'CX', 'GX', 'OC', 'CR', 'SH', 'AG', 'GK', 'KM', 'DR']

// Swarm agent display labels
export const SWARM_AGENT_LABELS: Record<SwarmAgentType, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
  opencode: 'OpenCode'
}

// Tab display labels
export const TAB_LABELS: Record<TabId, string> = {
  floor: 'Floor',
  bench: 'Bench',
  panel: 'Panel'
}

// Install commands/links for each agent
export const AGENT_INSTALL_INFO: Record<string, { command?: string; url?: string }> = {
  claude: { command: 'npm install -g @anthropic-ai/claude-code' },
  codex: { command: 'npm install -g @openai/codex' },
  gemini: { command: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' },
  opencode: { url: 'https://github.com/opencode-ai/opencode' },
  cursor: { url: 'https://cursor.com' },
  antigravity: { command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', url: 'https://antigravity.google' },
  grok: { command: 'curl -fsSL https://x.ai/cli/install.sh | bash', url: 'https://x.ai' },
  kimi: { command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', url: 'https://code.kimi.com' },
  droid: { command: 'curl -fsSL https://app.factory.ai/cli | sh', url: 'https://factory.ai' },
}

// agents-cli package for managing agent configurations
export const AGENTS_CLI_PACKAGE = '@swarmify/agents-cli'
export const AGENTS_CLI_INSTALL_COMMAND = `npm install -g ${AGENTS_CLI_PACKAGE}`

// Map from agent title (CL, CX, etc.) to key (claude, codex, etc.)
export const AGENT_TITLE_TO_KEY: Record<string, string> = {
  'CC': 'claude',
  'CX': 'codex',
  'GX': 'gemini',
  'OC': 'opencode',
  'CR': 'cursor',
  'SH': 'shell',
  'AG': 'antigravity',
  'GK': 'grok',
  'KM': 'kimi',
  'DR': 'droid',
  'Claude': 'claude',
  'Codex': 'codex',
  'Gemini': 'gemini',
  'OpenCode': 'opencode',
  'Cursor': 'cursor',
  'Shell': 'shell',
  'Antigravity': 'antigravity',
  'Grok': 'grok',
  'Kimi': 'kimi',
  'Droid': 'droid',
}

// Map from key to title (for dropdown)
export const AGENT_KEY_TO_TITLE: Record<string, string> = {
  'claude': 'CC',
  'codex': 'CX',
  'gemini': 'GX',
  'opencode': 'OC',
  'cursor': 'CR',
  'antigravity': 'AG',
  'grok': 'GK',
  'kimi': 'KM',
  'droid': 'DR',
}

// Notification-capable agents
export const NOTIFICATION_AGENTS = [
  { key: 'claude', name: 'Claude', supported: true },
  { key: 'codex', name: 'Codex', supported: false },
  { key: 'gemini', name: 'Gemini', supported: false },
  { key: 'antigravity', name: 'Antigravity', supported: false },
  { key: 'grok', name: 'Grok', supported: false },
  { key: 'kimi', name: 'Kimi', supported: false },
  { key: 'droid', name: 'Droid', supported: false },
  { key: 'opencode', name: 'OpenCode', supported: false },
  { key: 'cursor', name: 'Cursor', supported: false },
  { key: 'shell', name: 'Shell', supported: false },
]

// Markdown rendering allowed tags
export const TODO_MARKDOWN_ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'span',
  'ul'
]

// Markdown rendering allowed attributes
export const TODO_MARKDOWN_ALLOWED_ATTRS = ['href', 'title', 'target', 'rel', 'class']

// Sessions per page for pagination
export const SESSIONS_PER_PAGE = 20

// Factory function to create BUILT_IN_AGENTS (needs icons at runtime)
export function createBuiltInAgents(icons: {
  claude: string
  codex: ThemedIcon
  gemini: string
  opencode: string
  cursor: ThemedIcon
  shell: string
  antigravity: string
  grok: ThemedIcon
  kimi: string
  droid: ThemedIcon
}): BuiltInAgentConfig[] {
  return [
    { key: 'claude', name: 'Claude', icon: icons.claude },
    { key: 'codex', name: 'Codex', icon: icons.codex },
    { key: 'gemini', name: 'Gemini', icon: icons.gemini },
    { key: 'antigravity', name: 'Antigravity', icon: icons.antigravity },
    { key: 'grok', name: 'Grok', icon: icons.grok },
    { key: 'kimi', name: 'Kimi', icon: icons.kimi },
    { key: 'droid', name: 'Droid', icon: icons.droid },
    { key: 'opencode', name: 'OpenCode', icon: icons.opencode },
    { key: 'cursor', name: 'Cursor', icon: icons.cursor },
    { key: 'shell', name: 'Shell', icon: icons.shell },
  ]
}
