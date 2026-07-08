import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  getBackupsDir,
  getCommandsDir,
  getDriveDir,
  getHooksDir,
  getPackagesDir,
  getPluginsDir,
  getRoutinesDir,
  getRunsDir,
  getShimsDir,
  getSkillsDir,
  getTrashDir,
  getTrashVersionsDir,
  getVersionsDir,
} from '../state.js';

describe('state paths', () => {
  it('keeps system resource directories under ~/.agents/.system', () => {
    const systemRoot = path.join(os.homedir(), '.agents', '.system');

    expect(getCommandsDir()).toBe(path.join(systemRoot, 'commands'));
    expect(getHooksDir()).toBe(path.join(systemRoot, 'hooks'));
    expect(getSkillsDir()).toBe(path.join(systemRoot, 'skills'));
  });

  it('stores durable runtime state under ~/.agents/.history', () => {
    const userRoot = path.join(os.homedir(), '.agents');
    const history = path.join(userRoot, '.history');

    expect(getVersionsDir()).toBe(path.join(history, 'versions'));
    expect(getRunsDir()).toBe(path.join(history, 'runs'));
    expect(getBackupsDir()).toBe(path.join(history, 'backups'));
    expect(getTrashDir()).toBe(path.join(history, 'trash'));
    expect(getTrashVersionsDir()).toBe(path.join(history, 'trash', 'versions'));
  });

  it('stores regenerable runtime state under ~/.agents/.cache', () => {
    const userRoot = path.join(os.homedir(), '.agents');
    const cache = path.join(userRoot, '.cache');

    expect(getPackagesDir()).toBe(path.join(cache, 'packages'));
    expect(getShimsDir()).toBe(path.join(cache, 'shims'));
    expect(getDriveDir()).toBe(path.join(cache, 'drive'));
  });

  it('keeps definitions/configs at the top of ~/.agents', () => {
    const userRoot = path.join(os.homedir(), '.agents');
    expect(getRoutinesDir()).toBe(path.join(userRoot, 'routines'));
    // Plugins are user-authored resources, alongside skills/, commands/, etc.
    expect(getPluginsDir()).toBe(path.join(userRoot, 'plugins'));
  });
});

describe('readMeta merges agents.yaml from both repos', () => {
  let testDir: string;
  let userDir: string;
  let systemDir: string;
  const modulePath = path.resolve(process.cwd(), 'src/lib/state.ts');

  function runReadMeta(home: string): Record<string, unknown> {
    const result = execFileSync(
      'bun',
      [
        '-e',
        `import { readMeta } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(readMeta()));`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdio: 'pipe',
        encoding: 'utf8',
      },
    ).trim();
    return JSON.parse(result);
  }

  function runStateScript(home: string, script: string): string {
    return execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  // Uses Node.js instead of Bun because the rename-failure test needs
  // syncBuiltinESMExports() to propagate a monkey-patched fs.renameSync
  // across ESM module boundaries — a Node.js-only API not available in Bun.
  function runStateScriptWithNode(home: string, script: string): string {
    return execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  function spawnStateScript(home: string, script: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('bun', ['-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`state script exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    userDir = path.join(testDir, '.agents');
    systemDir = path.join(userDir, '.system');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(systemDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('merges agents from both system and user repos, user wins on conflict', () => {
    // System repo has claude@1.0.0 and codex@2.0.0
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n  codex: "2.0.0"\n'
    );
    // User repo has claude@3.0.0 (overrides) and gemini@1.0.0 (new)
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "3.0.0"\n  gemini: "1.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    // claude should be 3.0.0 (user wins)
    expect(agents.claude).toBe('3.0.0');
    // codex should be 2.0.0 (from system, not in user)
    expect(agents.codex).toBe('2.0.0');
    // gemini should be 1.0.0 (from user, not in system)
    expect(agents.gemini).toBe('1.0.0');
  });

  it('reads from system repo when user repo has no agents.yaml', () => {
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    expect(agents.claude).toBe('1.0.0');
  });

  it('reads from user repo when system repo has no agents.yaml', () => {
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "2.0.0"\n'
    );

    const meta = runReadMeta(testDir);
    const agents = meta.agents as Record<string, string>;

    expect(agents.claude).toBe('2.0.0');
  });

  it('does not lose concurrent updateMeta callback writes', async () => {
    // Hold the meta lock through the callback longer than the old count-bounded
    // retry budget (~750ms). The loser of the race must wait this out and still
    // land its write; on the pre-fix lock it would exhaust its retries, throw,
    // and silently drop a write — so this deterministically guards #306.
    const HOLD_MS = 1_000;
    const makeUpdate = (agent: string, version: string) => `
      const { updateMeta } = await import(${JSON.stringify(modulePath)});
      updateMeta((meta) => {
        const block = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(block, 0, 0, ${HOLD_MS});
        return {
          ...meta,
          agents: {
            ...(meta.agents ?? {}),
            ${JSON.stringify(agent)}: ${JSON.stringify(version)},
          },
        };
      });
    `;

    await Promise.all([
      spawnStateScript(testDir, makeUpdate('claude', '1.0.0')),
      spawnStateScript(testDir, makeUpdate('codex', '2.0.0')),
    ]);

    const meta = runReadMeta(testDir);
    expect(meta.agents).toMatchObject({
      claude: '1.0.0',
      codex: '2.0.0',
    });
  });

  it('keeps the original agents.yaml when rename fails after writing the temp file', () => {
    const moduleUrl = pathToFileURL(modulePath).href;
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );

    const output = runStateScriptWithNode(testDir, `
      import fs from 'fs';
      import path from 'path';
      import { syncBuiltinESMExports } from 'module';

      const target = path.join(process.env.HOME, '.agents', 'agents.yaml');
      const originalRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === target) throw new Error('simulated rename failure');
        return originalRename(from, to);
      };
      syncBuiltinESMExports();

      const { writeMeta } = await import(${JSON.stringify(moduleUrl)});
      try {
        writeMeta({ agents: { claude: '9.9.9' } });
      } catch (err) {
        console.log(String(err.message));
      }
      console.log(fs.readFileSync(target, 'utf-8'));
    `);

    expect(output).toContain('simulated rename failure');
    expect(output).toContain('claude: "1.0.0"');
    expect(output).not.toContain('9.9.9');
    expect(fs.readdirSync(userDir).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('breaks a stale agents.yaml lock older than five seconds', () => {
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(userDir, 'agents.yaml.lock'));
    const staleTime = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(userDir, 'agents.yaml.lock'), staleTime, staleTime);

    runStateScript(testDir, `
      const { updateMeta } = await import(${JSON.stringify(modulePath)});
      updateMeta((meta) => ({
        ...meta,
        agents: { ...(meta.agents ?? {}), codex: '2.0.0' },
      }));
    `);

    const meta = runReadMeta(testDir);
    expect(meta.agents).toMatchObject({
      claude: '1.0.0',
      codex: '2.0.0',
    });
  });

  it('caches parsed agents.yaml across repeated reads (no re-parse when mtime unchanged)', () => {
    const moduleUrl = pathToFileURL(modulePath).href;
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );

    // Spawn a single process that reads readMeta three times back-to-back AND counts how
    // many readFileSync calls hit agents.yaml. If the cache works, only the FIRST call
    // should read the file; subsequent calls should be served from memory.
    const output = runStateScriptWithNode(testDir, `
      import fs from 'fs';
      import path from 'path';
      import { syncBuiltinESMExports } from 'module';

      const targetUser = path.join(process.env.HOME, '.agents', 'agents.yaml');
      const targetSystem = path.join(process.env.HOME, '.agents', '.system', 'agents.yaml');
      const originalRead = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = (file, opts) => {
        if (file === targetUser || file === targetSystem) reads++;
        return originalRead(file, opts);
      };
      syncBuiltinESMExports();

      const { readMeta } = await import(${JSON.stringify(moduleUrl)});
      readMeta();
      const readsAfterFirst = reads;
      readMeta();
      readMeta();
      console.log(JSON.stringify({ readsAfterFirst, readsTotal: reads }));
    `);
    const counts = JSON.parse(output) as { readsAfterFirst: number; readsTotal: number };

    // After the first read, the cache should be primed. The next two reads must add zero
    // new yaml file reads against either source path.
    expect(counts.readsTotal).toBe(counts.readsAfterFirst);
    expect(counts.readsAfterFirst).toBeGreaterThan(0);
  });

  it('invalidates the cache when writeMeta runs', () => {
    const moduleUrl = pathToFileURL(modulePath).href;
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );

    const output = runStateScriptWithNode(testDir, `
      import { readMeta, writeMeta } from ${JSON.stringify(moduleUrl)};
      const before = readMeta();
      writeMeta({ ...before, agents: { ...before.agents, claude: '9.9.9' } });
      const after = readMeta();
      console.log(JSON.stringify({ before: before.agents?.claude, after: after.agents?.claude }));
    `);
    const result = JSON.parse(output) as { before: string; after: string };

    expect(result.before).toBe('1.0.0');
    expect(result.after).toBe('9.9.9');
  });

  it('refreshes the cache when the device pin file is modified out-of-band', () => {
    const moduleUrl = pathToFileURL(modulePath).href;
    // A central pin is transitional; the first readMeta lifts it into the
    // per-device file (which is authoritative). Out-of-band edits to that file
    // must invalidate the cache.
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "1.0.0"\n',
      'utf-8',
    );

    const output = runStateScriptWithNode(testDir, `
      import fs from 'fs';
      import path from 'path';
      import { readMeta, getDeviceMetaPath } from ${JSON.stringify(moduleUrl)};

      const before = readMeta(); // reads the central pin, lifting it into the device file
      const devicePath = getDeviceMetaPath();

      // Wait long enough for the mtime to definitely advance (HFS+ mtime is per-second).
      await new Promise((r) => setTimeout(r, 1100));
      fs.mkdirSync(path.dirname(devicePath), { recursive: true });
      fs.writeFileSync(devicePath, 'agents:\\n  claude: "2.0.0"\\n', 'utf-8');

      const after = readMeta();
      console.log(JSON.stringify({ before: before.agents?.claude, after: after.agents?.claude }));
    `);
    const result = JSON.parse(output) as { before: string; after: string };

    expect(result.before).toBe('1.0.0');
    expect(result.after).toBe('2.0.0');
  });
});

describe('agents.yaml device-local split (routing + read overlay)', () => {
  let home: string;
  const MACHINE = 'testbox';
  const modulePath = path.resolve(process.cwd(), 'src/lib/state.ts');
  const moduleUrl = pathToFileURL(modulePath).href;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-split-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function run(script: string): string {
    return execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, AGENTS_SYNC_MACHINE_ID: MACHINE },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  }

  it('routes agents: -> per-device file, versions: -> history json, rest -> central', () => {
    const out = run(`
      import * as fs from 'fs';
      import * as yaml from 'yaml';
      import { writeMeta, getDeviceMetaPath, getVersionResourcesPath } from ${JSON.stringify(moduleUrl)};
      writeMeta({
        agents: { claude: '2.1.0' },
        versions: { claude: { '2.1.0': { rulesPreset: 'default' } } },
        run: { claude: { strategy: 'balanced' } },
      });
      const central = yaml.parse(fs.readFileSync(process.env.HOME + '/.agents/agents.yaml', 'utf8')) || {};
      const device = yaml.parse(fs.readFileSync(getDeviceMetaPath(), 'utf8'));
      const history = JSON.parse(fs.readFileSync(getVersionResourcesPath(), 'utf8'));
      console.log(JSON.stringify({
        centralHasAgents: 'agents' in central,
        centralHasVersions: 'versions' in central,
        centralRun: central.run && central.run.claude && central.run.claude.strategy,
        deviceAgents: device.agents,
        history,
        devicePath: getDeviceMetaPath(),
      }));
    `);
    const r = JSON.parse(out);
    expect(r.centralHasAgents).toBe(false);
    expect(r.centralHasVersions).toBe(false);
    expect(r.centralRun).toBe('balanced');
    expect(r.deviceAgents).toEqual({ claude: '2.1.0' });
    expect(r.history).toEqual({ claude: { '2.1.0': { rulesPreset: 'default' } } });
    expect(r.devicePath).toContain(path.join('devices', MACHINE, 'agents.yaml'));
  });

  it('readMeta re-assembles agents: and versions: from the split files', () => {
    const out = run(`
      import { writeMeta, readMeta } from ${JSON.stringify(moduleUrl)};
      writeMeta({
        agents: { claude: '2.1.0', codex: '0.1.0' },
        versions: { claude: { '2.1.0': { rulesPreset: 'x' } } },
        hosts: { box: { source: 'inline', address: 'h' } },
      });
      console.log(JSON.stringify(readMeta()));
    `);
    const meta = JSON.parse(out);
    expect(meta.agents).toEqual({ claude: '2.1.0', codex: '0.1.0' });
    expect(meta.versions).toEqual({ claude: { '2.1.0': { rulesPreset: 'x' } } });
    expect(meta.hosts).toBeDefined();
  });

  it('does not create a device file when there are no pins', () => {
    const out = run(`
      import * as fs from 'fs';
      import { writeMeta, getDeviceMetaPath } from ${JSON.stringify(moduleUrl)};
      writeMeta({ run: { claude: { strategy: 'balanced' } } });
      console.log(JSON.stringify({ deviceExists: fs.existsSync(getDeviceMetaPath()) }));
    `);
    expect(JSON.parse(out).deviceExists).toBe(false);
  });

  it('invalidates the cache when the history version-resources file changes out-of-band', () => {
    // Regression guard: the cache stamp must detect changes to the history file
    // at full mtime resolution (a numeric-sum stamp rounded these away).
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', `
      import fs from 'fs';
      import { readMeta, writeMeta, getVersionResourcesPath } from ${JSON.stringify(moduleUrl)};
      writeMeta({ versions: { claude: { '2.1.0': { rulesPreset: 'a' } } }, run: { claude: { strategy: 'balanced' } } });
      const before = readMeta().versions?.claude?.['2.1.0']?.rulesPreset;
      await new Promise((r) => setTimeout(r, 1100));
      fs.writeFileSync(getVersionResourcesPath(), JSON.stringify({ claude: { '2.1.0': { rulesPreset: 'b' } } }, null, 2));
      const after = readMeta().versions?.claude?.['2.1.0']?.rulesPreset;
      console.log(JSON.stringify({ before, after }));
    `], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, AGENTS_SYNC_MACHINE_ID: MACHINE },
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    const r = JSON.parse(out);
    expect(r.before).toBe('a');
    expect(r.after).toBe('b');
  });
});
