import { test, expect, describe } from 'bun:test'
import { agentIdFromPrefix } from './AgentAvatar'

// The feed maps an agent's terminal abbreviation (CC/CX/GX/…) to the agent id that
// backs its brand logo. Regression guard for the abbreviations added with logo support
// (AG -> antigravity, GK -> grok, KM -> kimi, DR -> droid) alongside the original set.
describe('agentIdFromPrefix', () => {
  test('maps the original built-in prefixes', () => {
    expect(agentIdFromPrefix('CC')).toBe('claude')
    expect(agentIdFromPrefix('CX')).toBe('codex')
    expect(agentIdFromPrefix('GX')).toBe('gemini')
    expect(agentIdFromPrefix('OC')).toBe('opencode')
    expect(agentIdFromPrefix('CR')).toBe('cursor')
    expect(agentIdFromPrefix('SH')).toBe('shell')
  })

  test('maps the logo-support additions', () => {
    expect(agentIdFromPrefix('AG')).toBe('antigravity')
    expect(agentIdFromPrefix('GK')).toBe('grok')
    expect(agentIdFromPrefix('KM')).toBe('kimi')
    expect(agentIdFromPrefix('DR')).toBe('droid')
  })

  test('returns null for unknown / empty prefixes so the caller can fall back', () => {
    expect(agentIdFromPrefix('ZZ')).toBeNull()
    expect(agentIdFromPrefix('')).toBeNull()
    expect(agentIdFromPrefix(null)).toBeNull()
    expect(agentIdFromPrefix(undefined)).toBeNull()
  })
})
