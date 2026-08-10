import type { CommandAlias } from '../types'

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
