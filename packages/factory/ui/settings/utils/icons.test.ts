import { test, expect } from 'bun:test'
import { getIcon } from './icons'

const themed = { dark: 'dark.png', light: 'light.png' }

test('getIcon returns empty string for missing icon', () => {
  expect(getIcon(undefined, true)).toBe('')
  expect(getIcon(null, false)).toBe('')
})

test('getIcon returns string icon as-is', () => {
  expect(getIcon('icon.png', true)).toBe('icon.png')
  expect(getIcon('icon.png', false)).toBe('icon.png')
})

test('getIcon returns themed icon based on theme', () => {
  expect(getIcon(themed, true)).toBe('light.png')
  expect(getIcon(themed, false)).toBe('dark.png')
})
