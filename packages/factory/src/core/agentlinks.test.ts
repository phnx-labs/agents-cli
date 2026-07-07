import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
import {
  AGENTS_FILENAME,
  AGENT_SYMLINK_TARGETS,
  isAgentsFileName,
  getSymlinkTargetsForFileName,
  getMissingTargets
} from './agentlinks';

describe('agentlinks', () => {
  test('recognizes AGENTS.md by exact file name', () => {
    expect(isAgentsFileName(AGENTS_FILENAME)).toBe(true);
    expect(isAgentsFileName('agents.md')).toBe(false);
  });

  test('fixture file resolves to AGENTS.md basename', () => {
    const fixturePath = path.join(__dirname, 'testdata', 'agentlinks', 'AGENTS.md');
    const contents = fs.readFileSync(fixturePath, 'utf8');
    expect(contents.length).toBeGreaterThan(0);
    expect(path.basename(fixturePath)).toBe(AGENTS_FILENAME);
  });

  test('returns symlink targets only for AGENTS.md', () => {
    expect(getSymlinkTargetsForFileName(AGENTS_FILENAME)).toEqual([
      ...AGENT_SYMLINK_TARGETS
    ]);
    expect(getSymlinkTargetsForFileName('README.md')).toEqual([]);
  });

  test('computes missing targets', () => {
    const candidates = ['CLAUDE.md', 'GEMINI.md', 'OTHER.md'];
    const existing = ['CLAUDE.md'];
    expect(getMissingTargets(candidates, existing)).toEqual(['GEMINI.md', 'OTHER.md']);
  });
});
