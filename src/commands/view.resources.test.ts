import { describe, expect, test } from 'vitest';
import { parseResourceSections } from './view.js';

// parseResourceSections is the merge point between the --resources/--detailed
// flags and the historically-ignored per-section booleans in --json mode. These
// tests pin the exact section set it produces for each flag combination.

const ALL = ['commands', 'skills', 'mcp', 'memory', 'hooks', 'workflows', 'plugins'].sort();

const sections = (opts: Parameters<typeof parseResourceSections>[0], json = true) =>
  [...parseResourceSections(opts, json)].sort();

describe('parseResourceSections', () => {
  test('no resource flags → empty set (default --json stays lean)', () => {
    expect(sections({})).toEqual([]);
  });

  test('--detailed → all sections', () => {
    expect(sections({ detailed: true })).toEqual(ALL);
  });

  test('--resources with no value (true) → all sections', () => {
    expect(sections({ resources: true })).toEqual(ALL);
  });

  test('--resources all → all sections', () => {
    expect(sections({ resources: 'all' })).toEqual(ALL);
  });

  test('--resources skills,plugins → just those two', () => {
    expect(sections({ resources: 'skills,plugins' })).toEqual(['plugins', 'skills']);
  });

  test('--resources rules maps to the memory section', () => {
    expect(sections({ resources: 'rules' })).toEqual(['memory']);
  });

  test('whitespace and casing are tolerated', () => {
    expect(sections({ resources: ' Skills , MCP ' })).toEqual(['mcp', 'skills']);
  });

  test('unknown section names are ignored, valid ones kept', () => {
    expect(sections({ resources: 'skills,bogus,plugins' })).toEqual(['plugins', 'skills']);
  });

  test('silent-ignore fix: in --json mode a bare --skills flag folds in', () => {
    expect(sections({ skills: true }, true)).toEqual(['skills']);
  });

  test('section booleans do NOT fold in outside --json mode', () => {
    // Without --json the per-section flags drive the human detail view, not JSON.
    expect(sections({ skills: true }, false)).toEqual([]);
  });

  test('--rules boolean folds into memory in --json mode', () => {
    expect(sections({ rules: true }, true)).toEqual(['memory']);
  });

  test('--resources value unions with section booleans', () => {
    expect(sections({ resources: 'skills', plugins: true }, true)).toEqual(['plugins', 'skills']);
  });
});
