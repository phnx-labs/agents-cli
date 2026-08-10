import { test, expect } from 'bun:test';
import { normalizeProjectKey, matchLinearProject, type LinearProjectLite } from './linearProjects';

test('normalizeProjectKey collapses name / slug / folder to one key', () => {
  expect(normalizeProjectKey('Agents CLI')).toBe('agentscli');
  expect(normalizeProjectKey('phnx-labs/agents-cli')).toBe('agentscli');
  expect(normalizeProjectKey('/Users/me/src/github.com/phnx-labs/agents-cli')).toBe('agentscli');
  expect(normalizeProjectKey('rush_app')).toBe('rushapp');
  expect(normalizeProjectKey('')).toBe('');
});

const PROJECTS: LinearProjectLite[] = [
  { id: 'a', name: 'Agents CLI' },
  { id: 'b', name: 'Rush App' },
  { id: 'c', name: 'Prix' },
];

test('matchLinearProject: exact normalized match wins', () => {
  expect(matchLinearProject('phnx-labs/agents-cli', PROJECTS)?.id).toBe('a');
  expect(matchLinearProject('rush-app', PROJECTS)?.id).toBe('b');
});

test('matchLinearProject: containment fallback for near names', () => {
  // "agents-cli-web" has no exact peer; "agentscliweb" contains "agentscli" -> Agents CLI.
  expect(matchLinearProject('agents-cli-web', PROJECTS)?.id).toBe('a');
});

test('matchLinearProject: no match returns undefined', () => {
  expect(matchLinearProject('totally-unrelated', PROJECTS)).toBeUndefined();
  expect(matchLinearProject('', PROJECTS)).toBeUndefined();
});
