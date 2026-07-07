import { expect, test } from 'bun:test'
import { formatPreviewTerminalTitle } from './formatting'
import type { DisplayPreferences } from '../types'

const DEFAULT_DISPLAY: DisplayPreferences = {
  showFullAgentNames: true,
  showLabelsInTitles: true,
  autoLabelInTabTitles: true,
  showSessionIdInTitles: true,
  labelReplacesTitle: false,
  showLabelOnlyOnFocus: false,
}

test('uses short code when showFullAgentNames is false', () => {
  const display: DisplayPreferences = { ...DEFAULT_DISPLAY, showFullAgentNames: false, showSessionIdInTitles: false }
  expect(formatPreviewTerminalTitle('CX', display)).toBe('CX')
})

test('includes session chunk and label', () => {
  expect(
    formatPreviewTerminalTitle('CX', DEFAULT_DISPLAY, {
      label: 'Agent Terminals',
      sessionChunk: 'a1b2c3d4',
    })
  ).toBe('Codex a1b2c3d4 - Agent Terminals')
})

test('hides labels when showLabelsInTitles is false', () => {
  const display: DisplayPreferences = { ...DEFAULT_DISPLAY, showLabelsInTitles: false }
  expect(
    formatPreviewTerminalTitle('CX', display, {
      label: 'Agent Terminals',
      sessionChunk: 'a1b2c3d4',
    })
  ).toBe('Codex a1b2c3d4')
})

test('replaces title with label when labelReplacesTitle is true and no session chunk', () => {
  const display: DisplayPreferences = {
    ...DEFAULT_DISPLAY,
    labelReplacesTitle: true,
    showSessionIdInTitles: false,
  }
  expect(
    formatPreviewTerminalTitle('CX', display, {
      label: 'Agent Terminals',
    })
  ).toBe('Agent Terminals')
})

test('hides labels when terminal is not focused and showLabelOnlyOnFocus is true', () => {
  const display: DisplayPreferences = {
    ...DEFAULT_DISPLAY,
    showSessionIdInTitles: false,
    showLabelOnlyOnFocus: true,
  }
  expect(
    formatPreviewTerminalTitle('CX', display, {
      label: 'Agent Terminals',
      isFocused: false,
    })
  ).toBe('Codex')
})
