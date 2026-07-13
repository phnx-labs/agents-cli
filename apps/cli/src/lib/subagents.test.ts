import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { transformSubagentForCopilot } from './subagents.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-subagents-'));
  tempDirs.push(dir);
  return dir;
}

function makeSubagentDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nname: ${name}\ndescription: Test ${name} agent\nmodel: gpt-4o\n---\n\nYou are the ${name} agent.\n`,
    'utf-8'
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('transformSubagentForCopilot', () => {
  it('emits a Copilot CLI custom agent profile (.agent.md)', () => {
    const dir = makeSubagentDir(makeTempDir(), 'security-auditor');
    const output = transformSubagentForCopilot(dir);

    expect(output).toContain('name: security-auditor');
    expect(output).toContain('description: Test security-auditor agent');
    expect(output).toContain('model: gpt-4o');
    expect(output).toContain('You are the security-auditor agent.');
  });

  it('appends additional .md files as sections', () => {
    const parent = makeTempDir();
    const dir = makeSubagentDir(parent, 'reviewer');
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'Extra notes.', 'utf-8');

    const output = transformSubagentForCopilot(dir);
    expect(output).toContain('## Notes');
    expect(output).toContain('Extra notes.');
  });
});
