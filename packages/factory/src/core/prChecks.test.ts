import { test, expect } from 'bun:test'
import { aggregateChecks, parseGhChecks } from './prChecks'

test('any failing check dominates -> failed', () => {
  expect(aggregateChecks([{ bucket: 'pass' }, { bucket: 'fail' }, { bucket: 'pending' }])).toBe('failed')
  expect(aggregateChecks([{ state: 'SUCCESS' }, { state: 'ERROR' }])).toBe('failed')
  expect(aggregateChecks([{ bucket: 'cancel' }])).toBe('failed')
})

test('pending (no failures) -> running', () => {
  expect(aggregateChecks([{ bucket: 'pass' }, { bucket: 'pending' }])).toBe('running')
  expect(aggregateChecks([{ state: 'IN_PROGRESS' }])).toBe('running')
})

test('all passing -> passed', () => {
  expect(aggregateChecks([{ bucket: 'pass' }, { bucket: 'pass' }])).toBe('passed')
  expect(aggregateChecks([{ state: 'SUCCESS' }])).toBe('passed')
})

test('skipping-only or empty -> null (no CI to report)', () => {
  expect(aggregateChecks([])).toBe(null)
  expect(aggregateChecks([{ bucket: 'skipping' }])).toBe(null)
})

test('parseGhChecks tolerates junk and empty', () => {
  expect(parseGhChecks('')).toBe(null)
  expect(parseGhChecks('not json')).toBe(null)
  expect(parseGhChecks('{}')).toBe(null)
  expect(parseGhChecks('[{"bucket":"pass"}]')).toBe('passed')
})
