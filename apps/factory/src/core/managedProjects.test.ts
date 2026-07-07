import { test, expect } from 'bun:test';
import {
  bucketConfidence,
  projectNameFromPath,
  candidateToManaged,
  sanitizeManagedProjects,
} from './managedProjects';

test('bucketConfidence bands by frequency', () => {
  expect(bucketConfidence(0)).toBe('low');
  expect(bucketConfidence(2)).toBe('low');
  expect(bucketConfidence(3)).toBe('medium');
  expect(bucketConfidence(9)).toBe('medium');
  expect(bucketConfidence(10)).toBe('high');
  expect(bucketConfidence(100)).toBe('high');
});

test('projectNameFromPath returns the folder basename', () => {
  expect(projectNameFromPath('/Users/me/src/github.com/phnx-labs/agents-cli')).toBe('agents-cli');
  expect(projectNameFromPath('/a/b/')).toBe('b');
});

test('candidateToManaged derives slug + name + confidence', () => {
  const m = candidateToManaged({ path: '/Users/me/src/github.com/phnx-labs/agents-cli', freq: 12, lastUsed: 0 });
  expect(m.name).toBe('agents-cli');
  expect(m.repoSlug).toBe('phnx-labs/agents-cli');
  expect(m.id).toBe('phnx-labs/agents-cli');
  expect(m.confidence).toBe('high');
  expect(m.source).toBe('detected');
});

test('candidateToManaged prefers an explicit repo over the derived slug', () => {
  const m = candidateToManaged({ path: '/tmp/scratch', repo: 'owner/scratch', freq: 1, lastUsed: 0 });
  expect(m.repoSlug).toBe('owner/scratch');
  expect(m.id).toBe('owner/scratch');
  expect(m.confidence).toBe('low');
});

test('sanitizeManagedProjects drops malformed rows and coerces enums', () => {
  const cleaned = sanitizeManagedProjects([
    { id: 'a', name: 'A', path: '/a', confidence: 'high', source: 'manual' },
    { id: 'b', name: 'B', path: '/b', confidence: 'bogus', source: 'nope' }, // coerced
    { id: 'c', name: 'C' }, // missing path -> dropped
    'garbage', // dropped
    null, // dropped
  ]);
  expect(cleaned.map((p) => p.id)).toEqual(['a', 'b']);
  expect(cleaned[0].source).toBe('manual');
  expect(cleaned[1].confidence).toBe('low'); // coerced from bogus
  expect(cleaned[1].source).toBe('detected'); // coerced from nope
});

test('sanitizeManagedProjects on non-array returns empty', () => {
  expect(sanitizeManagedProjects({})).toEqual([]);
  expect(sanitizeManagedProjects(null)).toEqual([]);
});
