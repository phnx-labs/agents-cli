import { test, expect } from 'bun:test'
import { upsertView, removeView, viewMatches, type SavedView } from './savedViews'

const base: SavedView = { name: 'Today', sort: 'needs', status: [], abbrs: ['CC'], search: '' }

test('upsertView appends a new view', () => {
  const out = upsertView([], base)
  expect(out).toHaveLength(1)
  expect(out[0].name).toBe('Today')
})

test('upsertView replaces a same-named view in place, no duplicate', () => {
  const views = [base, { ...base, name: 'Eng', sort: 'recent' as const }]
  const out = upsertView(views, { ...base, search: 'auth' })
  expect(out).toHaveLength(2)
  expect(out[0].search).toBe('auth')
  expect(out[1].name).toBe('Eng')
})

test('upsertView trims and rejects blank names', () => {
  expect(upsertView([], { ...base, name: '   ' })).toHaveLength(0)
  expect(upsertView([], { ...base, name: '  Today  ' })[0].name).toBe('Today')
})

test('removeView drops by name', () => {
  expect(removeView([base], 'Today')).toHaveLength(0)
  expect(removeView([base], 'Nope')).toHaveLength(1)
})

test('viewMatches is order-insensitive on chip arrays', () => {
  const v: SavedView = { name: 'x', sort: 'needs', status: ['running', 'needs'], abbrs: ['CC', 'GX'], search: '' }
  expect(viewMatches(v, { sort: 'needs', status: ['needs', 'running'], abbrs: ['GX', 'CC'], search: '' })).toBe(true)
  expect(viewMatches(v, { sort: 'recent', status: ['needs', 'running'], abbrs: ['GX', 'CC'], search: '' })).toBe(false)
  expect(viewMatches(v, { sort: 'needs', status: ['needs'], abbrs: ['GX', 'CC'], search: '' })).toBe(false)
})
