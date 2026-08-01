import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function runHooksWriterFixture(scriptBody: string): unknown {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-writer-'));
  try {
    const script = `
      import * as fs from 'fs';
      import * as path from 'path';
      import { getWriter } from './src/lib/staleness/registry.ts';

      const home = process.env.HOME;
      if (!home) throw new Error('HOME missing');
      const userDir = path.join(home, '.agents');
      const projectRoot = path.join(home, 'project');
      const version = '2.1.143';
      const versionHome = path.join(home, '.agents', '.history', 'versions', 'claude', version, 'home');
      const agentDir = path.join(versionHome, '.claude');
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });
      const writer = getWriter('hooks', 'claude');
      if (!writer) throw new Error('claude hooks writer missing');
      ${scriptBody}
    `;
    const out = execFileSync('bun', ['--eval', script], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    return JSON.parse(out.trim());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('hooks writer', () => {
  it('copies selected hook directories recursively', () => {
    const result = runHooksWriterFixture(`
      const testsDir = path.join(userDir, 'hooks', 'tests');
      fs.mkdirSync(path.join(testsDir, 'fixtures'), { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'fixtures', 'input.json'), '{"ok":true}\\n', 'utf-8');

      const writeResult = writer.write({ version, versionHome, selection: ['tests'], cwd: projectRoot });
      const copied = path.join(agentDir, 'hooks', 'tests', 'fixtures', 'input.json');
      console.log(JSON.stringify({
        synced: writeResult.synced,
        copiedContent: fs.readFileSync(copied, 'utf-8'),
      }));
    `) as { synced: string[]; copiedContent: string };

    expect(result.synced).toEqual(['tests']);
    expect(result.copiedContent).toBe('{"ok":true}\n');
  });
});
