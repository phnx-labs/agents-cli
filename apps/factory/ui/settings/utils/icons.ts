import type { ThemedIcon, ContextAgentType, IconConfig } from '../types'

/**
 * Get the appropriate icon path based on theme
 */
export function getIcon(icon: string | ThemedIcon | null | undefined, isLight: boolean): string {
  if (!icon) return ''
  return typeof icon === 'string' ? icon : isLight ? icon.light : icon.dark
}

/**
 * Get the icon for a context agent type
 */
export function getAgentIcon(
  agent: ContextAgentType,
  icons: IconConfig,
  isLight: boolean
): string {
  switch (agent) {
    case 'claude':
      return icons.claude
    case 'gemini':
      return icons.gemini
    case 'codex':
      return getIcon(icons.codex, isLight)
    case 'agents':
      return icons.agents
    case 'cursor':
      return getIcon(icons.cursor, isLight)
    case 'opencode':
      return icons.opencode
    default:
      return icons.agents
  }
}
