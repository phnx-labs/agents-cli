import type { CustomAgentSettings, CommandAlias } from '../types'
import { RESERVED_NAMES } from '../constants'

/**
 * Validate a custom agent name
 * @param name - The name to validate
 * @param existingAgents - List of existing custom agents to check for duplicates
 * @returns Error message or empty string if valid
 */
export function validateAgentName(name: string, existingAgents: CustomAgentSettings[]): string {
  const upper = name.toUpperCase()
  if (upper.length === 0) return 'Name required'
  if (upper.length > 2) return 'Max 2 characters'
  if (!/^[A-Z]+$/.test(upper)) return 'Letters only'
  if (RESERVED_NAMES.includes(upper)) return 'Name already used'
  if (existingAgents.some(a => a.name === upper)) return 'Name already used'
  return ''
}

/**
 * Validate a command alias name
 * @param name - The name to validate
 * @param existingAliases - List of existing aliases to check for duplicates
 * @returns Error message or empty string if valid
 */
export function validateAliasName(name: string, existingAliases: CommandAlias[]): string {
  if (!name.trim()) return 'Name required'
  if (name.length > 20) return 'Max 20 characters'
  if (existingAliases.some(a => a.name.toLowerCase() === name.toLowerCase())) return 'Name already used'
  return ''
}
