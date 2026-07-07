import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { discoverInstructionsFromRepo, discoverRuleFilesFromRepo } from './rules.js';

let tmpDir: string;

function writeFile(rel: string, content: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('rules repo discovery', () => {
  it('finds top-level instructions in repo rules/', () => {
    writeFile('rules/CLAUDE.md', '# claude');

    const discovered = discoverInstructionsFromRepo(tmpDir);

    expect(discovered.some((entry) => entry.agentId === 'claude')).toBe(true);
  });

  it('finds nested preset fragments and excludes rules README', () => {
    writeFile('rules/AGENTS.md', '@presets/proactive.md');
    writeFile('rules/README.md', '# docs');
    writeFile('rules/presets/proactive.md', '@../default/core.md');
    writeFile('rules/default/core.md', 'be precise');

    const discovered = discoverRuleFilesFromRepo(tmpDir);

    expect(discovered).toEqual([
      'AGENTS.md',
      'default/core.md',
      'presets/proactive.md',
    ]);
  });
});
