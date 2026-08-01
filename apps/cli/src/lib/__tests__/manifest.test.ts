import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const manifestPath = path.resolve(process.cwd(), 'src/lib/manifest.ts');

describe('writeManifest concurrent safety', () => {
  let testDir: string;

  function runManifestScript(home: string, script: string): string {
    return execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  function spawnWriteManifest(repoPath: string, agentKey: string, version: string): Promise<void> {
    // Each process: read existing manifest, stall 200ms to force overlap, then write.
    // The lock+atomic-rename in writeManifest ensures the file is never left corrupt,
    // even though last-writer-wins means only one agent key may survive.
    const script = `
      const { readManifest, writeManifest } = await import(${JSON.stringify(manifestPath)});
      const existing = readManifest(${JSON.stringify(repoPath)}) ?? {};
      const block = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(block, 0, 0, 200);
      writeManifest(${JSON.stringify(repoPath)}, {
        ...existing,
        agents: { ...(existing.agents ?? {}), ${JSON.stringify(agentKey)}: ${JSON.stringify(version)} },
      });
    `;
    return new Promise((resolve, reject) => {
      const child = spawn('bun', ['-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: testDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`writeManifest script exited ${code}\nstderr:\n${stderr}`));
      });
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    fs.writeFileSync(path.join(testDir, 'agents.yaml'), 'agents: {}\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('leaves a valid YAML file under concurrent writes (no corruption)', async () => {
    await Promise.all([
      spawnWriteManifest(testDir, 'claude', '1.0.0'),
      spawnWriteManifest(testDir, 'codex', '2.0.0'),
    ]);

    // File must be parseable YAML — the primary guarantee of atomic rename.
    runManifestScript(testDir, `
      const { readManifest } = await import(${JSON.stringify(manifestPath)});
      const m = readManifest(${JSON.stringify(testDir)});
      if (!m || typeof m !== 'object') throw new Error('not an object: ' + JSON.stringify(m));
    `);

    // No leftover tmp files.
    expect(fs.readdirSync(testDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('leaves no temp files when write succeeds', () => {
    runManifestScript(testDir, `
      const { writeManifest } = await import(${JSON.stringify(manifestPath)});
      writeManifest(${JSON.stringify(testDir)}, { agents: { claude: '1.0.0' } });
    `);
    expect(fs.readdirSync(testDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
    const raw = fs.readFileSync(path.join(testDir, 'agents.yaml'), 'utf-8');
    expect(raw).toContain('claude');
  });
});
