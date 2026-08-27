import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync, spawn } from 'child_process';
import { memoryTargetDir } from './memory.js';
import { claudeProjectDirName } from './project-key.js';

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
        result.then((r) => console.log(JSON.stringify(r === undefined ? null : r)));
      } else {
        console.log(JSON.stringify(result === undefined ? null : result));
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

/** Same as {@link runMemory}, but async and non-blocking — for racing two real processes. */
function runMemoryAsync(home: string, expression: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      tsxBin,
      ['-e', `
        import * as memory from ${JSON.stringify(memoryModuleUrl)};
        ${expression};
      `],
      { env: { ...process.env, HOME: home } },
    );
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
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

  it('isFactFile excludes all rule/index files and lists only user facts', () => {
    const home = makeTempHome();
    const memDir = path.join(home, '.agents', 'memory');
    fs.mkdirSync(memDir, { recursive: true });

    // Rule and index files that must be excluded
    fs.writeFileSync(path.join(memDir, 'AGENTS.md'), '# rules', 'utf-8');
    fs.writeFileSync(path.join(memDir, 'README.md'), '# readme', 'utf-8');
    fs.writeFileSync(path.join(memDir, 'CLAUDE.md'), '# claude', 'utf-8');
    fs.writeFileSync(path.join(memDir, 'GEMINI.md'), '# gemini', 'utf-8');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# index', 'utf-8');
    // The one real fact
    fs.writeFileSync(path.join(memDir, 'my-fact.md'), '# fact', 'utf-8');

    const child = spawnSync(
      tsxBin,
      ['-e', `
        import * as memory from ${JSON.stringify(memoryModuleUrl)};
        const facts = memory.listMemoryFacts(${JSON.stringify(home)});
        console.log(JSON.stringify(facts.map(f => f.name)));
      `],
      { env: { ...process.env, HOME: home }, encoding: 'utf-8' },
    );
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    const names = JSON.parse((child.stdout || '').trim()) as string[];
    expect(names).toEqual(['my-fact']);
    expect(names).not.toContain('AGENTS');
    expect(names).not.toContain('README');
    expect(names).not.toContain('CLAUDE');
    expect(names).not.toContain('GEMINI');
    expect(names).not.toContain('MEMORY');
  });

});

describe('claude native per-project memory sync (PHNX-2817)', () => {
  it('a note written under one version home is visible under another', () => {
    const home = makeTempHome();
    const cwd = path.join(home, 'projects', 'my-repo');
    const key = claudeProjectDirName(path.resolve(cwd));
    const nativeDirA = path.join(home, 'versions', 'claude', 'v-a', 'home', '.claude', 'projects', key, 'memory');
    const nativeDirB = path.join(home, 'versions', 'claude', 'v-b', 'home', '.claude', 'projects', key, 'memory');
    const versionHomeA = path.join(home, 'versions', 'claude', 'v-a', 'home');
    const versionHomeB = path.join(home, 'versions', 'claude', 'v-b', 'home');

    runMemory(home, `memory.syncClaudeProjectMemoryDir(${JSON.stringify(versionHomeA)}, ${JSON.stringify(cwd)})`);
    expect(fs.lstatSync(nativeDirA).isSymbolicLink()).toBe(true);

    fs.writeFileSync(path.join(nativeDirA, 'note.md'), '# note\nwritten under v-a\n', 'utf-8');

    runMemory(home, `memory.syncClaudeProjectMemoryDir(${JSON.stringify(versionHomeB)}, ${JSON.stringify(cwd)})`);
    expect(fs.lstatSync(nativeDirB).isSymbolicLink()).toBe(true);

    const seenUnderB = path.join(nativeDirB, 'note.md');
    expect(fs.existsSync(seenUnderB)).toBe(true);
    expect(fs.readFileSync(seenUnderB, 'utf-8')).toContain('written under v-a');

    // Same canonical target — not two independent copies.
    const canonicalDir = runMemory(home, `memory.getClaudeProjectMemoryDir(${JSON.stringify(cwd)})`) as string;
    expect(fs.realpathSync(nativeDirA)).toBe(fs.realpathSync(canonicalDir));
    expect(fs.realpathSync(nativeDirB)).toBe(fs.realpathSync(canonicalDir));
  });

  it('migrates a pre-existing real directory\'s content instead of discarding it', () => {
    const home = makeTempHome();
    const cwd = path.join(home, 'projects', 'my-repo');
    const key = claudeProjectDirName(path.resolve(cwd));
    const versionHomeA = path.join(home, 'versions', 'claude', 'v-a', 'home');
    const nativeDirA = path.join(versionHomeA, '.claude', 'projects', key, 'memory');

    // Simulate the bug today: a real directory already holding a note, no symlink.
    fs.mkdirSync(nativeDirA, { recursive: true });
    fs.writeFileSync(path.join(nativeDirA, 'existing-note.md'), '# existing\nfrom before the fix\n', 'utf-8');

    runMemory(home, `memory.syncClaudeProjectMemoryDir(${JSON.stringify(versionHomeA)}, ${JSON.stringify(cwd)})`);

    expect(fs.lstatSync(nativeDirA).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(nativeDirA, 'existing-note.md'), 'utf-8')).toContain('from before the fix');

    const canonicalDir = runMemory(home, `memory.getClaudeProjectMemoryDir(${JSON.stringify(cwd)})`) as string;
    expect(fs.existsSync(path.join(canonicalDir, 'existing-note.md'))).toBe(true);

    // A second version home syncing afterward sees the migrated note too.
    const versionHomeB = path.join(home, 'versions', 'claude', 'v-b', 'home');
    const nativeDirB = path.join(versionHomeB, '.claude', 'projects', key, 'memory');
    runMemory(home, `memory.syncClaudeProjectMemoryDir(${JSON.stringify(versionHomeB)}, ${JSON.stringify(cwd)})`);
    expect(fs.readFileSync(path.join(nativeDirB, 'existing-note.md'), 'utf-8')).toContain('from before the fix');
  });

  it('is idempotent — re-syncing an already-linked dir is a no-op', () => {
    const home = makeTempHome();
    const cwd = path.join(home, 'projects', 'my-repo');
    const key = claudeProjectDirName(path.resolve(cwd));
    const versionHomeA = path.join(home, 'versions', 'claude', 'v-a', 'home');
    const nativeDirA = path.join(versionHomeA, '.claude', 'projects', key, 'memory');

    runMemory(home, `memory.syncClaudeProjectMemoryDir(${JSON.stringify(versionHomeA)}, ${JSON.stringify(cwd)})`);
    const targetBefore = fs.readlinkSync(nativeDirA);

    runMemory(home, `memory.syncClaudeProjectMemoryDir(${JSON.stringify(versionHomeA)}, ${JSON.stringify(cwd)})`);
    expect(fs.lstatSync(nativeDirA).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(nativeDirA)).toBe(targetBefore);
  });

  it('two concurrent first-time syncs of the same project race without throwing', async () => {
    const home = makeTempHome();
    const cwd = path.join(home, 'projects', 'my-repo');
    const key = claudeProjectDirName(path.resolve(cwd));
    const versionHomeA = path.join(home, 'versions', 'claude', 'v-a', 'home');
    const nativeDirA = path.join(versionHomeA, '.claude', 'projects', key, 'memory');

    // Two real processes syncing the SAME never-before-synced version home —
    // both see nothing at nativeDirA and race to create the symlink
    // (reproduces the EEXIST a second `agents run claude` launch can hit).
    const expr = `memory.syncClaudeProjectMemoryDir(${JSON.stringify(versionHomeA)}, ${JSON.stringify(cwd)})`;
    const [a, b] = await Promise.all([
      runMemoryAsync(home, expr),
      runMemoryAsync(home, expr),
    ]);

    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    expect(fs.lstatSync(nativeDirA).isSymbolicLink()).toBe(true);

    const canonicalDir = runMemory(home, `memory.getClaudeProjectMemoryDir(${JSON.stringify(cwd)})`) as string;
    expect(fs.realpathSync(nativeDirA)).toBe(fs.realpathSync(canonicalDir));
  });
});
