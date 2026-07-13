import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { memoryTargetDir } from './memory.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-memory-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const tsxBin = path.resolve('node_modules/.bin/tsx');
const memoryModuleUrl = pathToFileURL(path.resolve('src/lib/memory.ts')).href;

/** Run an expression against memory.ts under an isolated HOME. */
function runMemory(home: string, expression: string): unknown {
  const child = spawnSync(
    tsxBin,
    [
      '-e',
      `
      import * as memory from ${JSON.stringify(memoryModuleUrl)};
      const result = ${expression};
      if (result && typeof result.then === 'function') {
        result.then((r) => console.log(JSON.stringify(r)));
      } else {
        console.log(JSON.stringify(result));
      }
    `,
    ],
    { env: { ...process.env, HOME: home }, encoding: 'utf-8' },
  );
  if (child.status !== 0) {
    throw new Error(`memory helper failed: ${child.stderr || child.stdout}`);
  }
  const line = (child.stdout || '').trim().split('\n').filter(Boolean).pop() || 'null';
  return JSON.parse(line);
}

describe('memory resource (RUSH-1330)', () => {
  it('memoryTargetDir uses agent-native paths', () => {
    expect(memoryTargetDir('claude')).toMatch(/memory$/);
    expect(memoryTargetDir('codex')).toMatch(/memories$/);
    expect(memoryTargetDir('openclaw')).toBe('memory');
    expect(memoryTargetDir('grok')).toBe('memory');
  });

  it('add/list/view/remove round-trip on the user layer', () => {
    const home = makeTempHome();
    const added = runMemory(
      home,
      `memory.addMemoryFact('preferred-editor', 'User prefers vim keybindings')`,
    ) as string;
    expect(added).toContain('preferred-editor.md');
    expect(fs.existsSync(added)).toBe(true);

    const facts = runMemory(home, `memory.listMemoryFacts(${JSON.stringify(home)})`) as Array<{
      name: string;
      layer: string;
    }>;
    expect(facts.map((f) => f.name)).toContain('preferred-editor');
    expect(facts.find((f) => f.name === 'preferred-editor')?.layer).toBe('user');

    const removed = runMemory(home, `memory.removeMemoryFact('preferred-editor')`);
    expect(removed).toBe(true);
    const after = runMemory(home, `memory.listMemoryFacts(${JSON.stringify(home)})`) as unknown[];
    expect(after.find((f: any) => f.name === 'preferred-editor')).toBeUndefined();
  });

  it('syncMemoryToVersionHome copies facts into the claude target dir', () => {
    const home = makeTempHome();
    runMemory(home, `memory.addMemoryFact('team-conventions', 'Always run tests before push')`);
    const versionHome = path.join(home, 'version-home');
    fs.mkdirSync(versionHome, { recursive: true });

    const written = runMemory(
      home,
      `memory.syncMemoryToVersionHome('claude', ${JSON.stringify(versionHome)}, ${JSON.stringify(home)})`,
    ) as string[];
    expect(written).toContain('team-conventions');

    const target = path.join(versionHome, memoryTargetDir('claude'), 'team-conventions.md');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toContain('Always run tests');
    expect(fs.existsSync(path.join(versionHome, memoryTargetDir('claude'), 'MEMORY.md'))).toBe(true);
  });

  it('preserves unmanaged native memory markdown during sync (RUSH-1621)', () => {
    const home = makeTempHome();
    runMemory(home, `memory.addMemoryFact('team-conventions', 'Always run tests before push')`);
    const versionHome = path.join(home, 'version-home');
    const targetDir = path.join(versionHome, memoryTargetDir('claude'));
    fs.mkdirSync(targetDir, { recursive: true });
    const userFact = path.join(targetDir, 'my-personal-notes.md');
    fs.writeFileSync(userFact, '# personal notes\nkeep me\n', 'utf-8');

    runMemory(
      home,
      `memory.syncMemoryToVersionHome('claude', ${JSON.stringify(versionHome)}, ${JSON.stringify(home)})`,
    );

    expect(fs.existsSync(userFact)).toBe(true);
    expect(fs.readFileSync(userFact, 'utf-8')).toContain('keep me');
    expect(fs.existsSync(path.join(targetDir, 'team-conventions.md'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, '.agents-cli-memory.json'))).toBe(true);
  });

});
