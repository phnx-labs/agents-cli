import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installSubagentToAgent,
  listSubagentsForAgent,
  removeSubagentFromAgent,
  transformSubagentForKiro,
} from './subagents.js';

const tempDirs: string[] = [];

function makeSubagent(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-subagent-'));
  tempDirs.push(root);
  const subagentDir = path.join(root, 'reviewer');
  fs.mkdirSync(subagentDir);
  fs.writeFileSync(path.join(subagentDir, 'AGENT.md'), [
    '---',
    'name: reviewer',
    'description: Reviews changes',
    'model: claude-sonnet-4',
    'color: blue',
    '---',
    '',
    'Review the proposed changes.',
  ].join('\n'));
  fs.writeFileSync(path.join(subagentDir, 'SOUL.md'), 'Be precise.\n');
  return subagentDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Kiro subagents', () => {
  it('transforms the canonical definition into Kiro JSON', () => {
    const parsed = JSON.parse(transformSubagentForKiro(makeSubagent()));

    expect(parsed).toEqual({
      name: 'reviewer',
      description: 'Reviews changes',
      prompt: 'Review the proposed changes.\n\n## Soul\n\nBe precise.',
      tools: ['*'],
      model: 'claude-sonnet-4',
    });
    expect(parsed.color).toBeUndefined();
    expect(parsed.allowedTools).toBeUndefined();
  });

  it('installs, lists, and removes a Kiro agent through the real filesystem', () => {
    const subagentDir = makeSubagent();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-home-'));
    tempDirs.push(home);

    expect(installSubagentToAgent(subagentDir, 'reviewer', 'kiro', home)).toEqual({ success: true });
    const installedPath = path.join(home, '.kiro', 'agents', 'reviewer.json');
    expect(fs.existsSync(installedPath)).toBe(true);
    expect(listSubagentsForAgent('kiro', home)).toEqual([{
      name: 'reviewer',
      path: installedPath,
      files: ['reviewer.json'],
      frontmatter: { name: 'reviewer', description: 'Reviews changes' },
    }]);

    expect(removeSubagentFromAgent('reviewer', 'kiro', home)).toEqual({ success: true });
    expect(fs.existsSync(installedPath)).toBe(false);
  });
});
