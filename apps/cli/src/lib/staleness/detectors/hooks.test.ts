import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function runHooksDetectorFixture(scriptBody: string): unknown {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-detector-'));
  try {
    const script = `
      import * as fs from 'fs';
      import * as path from 'path';
      import { getDetector, getWriter } from './src/lib/staleness/registry.ts';

      const home = process.env.HOME;
      if (!home) throw new Error('HOME missing');
      const userDir = path.join(home, '.agents');
      const projectRoot = path.join(home, 'project');
      const version = '2.1.143';
      const versionHome = path.join(home, '.agents', '.history', 'versions', 'claude', version, 'home');
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
      const writer = getWriter('hooks', 'claude');
      const detector = getDetector('hooks', 'claude');
      if (!writer) throw new Error('claude hooks writer missing');
      if (!detector) throw new Error('claude hooks detector missing');
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

describe('hooks detector', () => {
  it('reports copied hook directories as synced', () => {
    const result = runHooksDetectorFixture(`
      const testsDir = path.join(userDir, 'hooks', 'tests');
      fs.mkdirSync(path.join(testsDir, 'fixtures'), { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'fixtures', 'input.json'), '{"ok":true}\\n', 'utf-8');

      const writeResult = writer.write({ version, versionHome, selection: ['tests'], cwd: projectRoot });
      const detected = detector.list({ version, versionHome, cwd: projectRoot });
      console.log(JSON.stringify({ written: writeResult.synced, detected }));
    `) as { written: string[]; detected: string[] };

    expect(result.written).toEqual(['tests']);
    expect(result.detected).toContain('tests');
  });
});
