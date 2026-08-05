/**
 * Tests for humans.ts — humans.yaml read/write.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-humans-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const tsxBin = path.resolve('node_modules/.bin/tsx');
const humansModuleUrl = pathToFileURL(path.resolve('src/lib/humans.ts')).href;

function runHumans(home: string, expression: string): unknown {
  const child = spawnSync(
    tsxBin,
    ['-e', `
      import * as humans from ${JSON.stringify(humansModuleUrl)};
      const result = ${expression};
      if (result && typeof result.then === 'function') {
        result.then((r) => console.log(JSON.stringify(r)));
      } else {
        console.log(JSON.stringify(result));
      }
    `],
    { env: { ...process.env, HOME: home }, encoding: 'utf-8' },
  );
  if (child.status !== 0) {
    throw new Error(`humans helper failed: ${child.stderr || child.stdout}`);
  }
  const line = (child.stdout || '').trim().split('\n').filter(Boolean).pop() || 'null';
  return JSON.parse(line);
}

describe('humans.ts', () => {
  it('readHumans returns null when file is absent', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    const result = runHumans(home, 'humans.readHumans()');
    expect(result).toBeNull();
  });

  it('writeHumans / readHumans round-trips correctly', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

    const config = JSON.stringify({
      version: 1,
      owner: {
        name: 'Test User',
        timezone: 'America/New_York',
        notify: { channel: 'imessage', to: '+15551234567' },
      },
    });

    runHumans(home, `(humans.writeHumans(${config}), 'ok')`);
    const read = runHumans(home, 'humans.readHumans()') as Record<string, unknown> | null;
    expect(read?.['version']).toBe(1);
    const owner = read?.['owner'] as Record<string, unknown> | undefined;
    expect(owner?.['name']).toBe('Test User');
    const notify = owner?.['notify'] as Record<string, unknown> | undefined;
    expect(notify?.['channel']).toBe('imessage');
    expect(notify?.['to']).toBe('+15551234567');
  });

  it('readHumans returns null for wrong version', () => {
    const home = makeTempHome();
    const agentsDir = path.join(home, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'humans.yaml'), 'version: 2\nowner:\n  name: x\n', 'utf-8');

    const result = runHumans(home, 'humans.readHumans()');
    expect(result).toBeNull();
  });

  it('getOwnerNotifyFromHumans returns null when file is absent', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    const result = runHumans(home, 'humans.getOwnerNotifyFromHumans()');
    expect(result).toBeNull();
  });

  it('isFactFile excludes rule files', () => {
    // Test the memory isFactFile behaviour inline via the module directly.
    // This test lives here as a sanity check for the rule-file exclusion.
    const memoryModuleUrl2 = pathToFileURL(path.resolve('src/lib/memory.ts')).href;
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.agents', 'memory'), { recursive: true });

    // Write rule files, the index, and a real fact
    const memDir = path.join(home, '.agents', 'memory');
    fs.writeFileSync(path.join(memDir, 'AGENTS.md'), '# rules', 'utf-8');
    fs.writeFileSync(path.join(memDir, 'claude.md'), '# claude', 'utf-8');
    fs.writeFileSync(path.join(memDir, 'gemini.md'), '# gemini', 'utf-8');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# index', 'utf-8');
    fs.writeFileSync(path.join(memDir, 'my-fact.md'), '# fact', 'utf-8');

    const child = spawnSync(
      tsxBin,
      ['-e', `
        import * as memory from ${JSON.stringify(memoryModuleUrl2)};
        const facts = memory.listMemoryFacts(${JSON.stringify(home)});
        console.log(JSON.stringify(facts.map(f => f.name)));
      `],
      { env: { ...process.env, HOME: home }, encoding: 'utf-8' },
    );
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    const names = JSON.parse((child.stdout || '').trim()) as string[];
    expect(names).toContain('my-fact');
    expect(names).not.toContain('AGENTS');
    expect(names).not.toContain('claude');
    expect(names).not.toContain('gemini');
    expect(names).not.toContain('MEMORY');
  });
});
