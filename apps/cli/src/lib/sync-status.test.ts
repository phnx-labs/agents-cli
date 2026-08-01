import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Real-filesystem tests for the unified sync-status engine. No mocks: we build a
 * temp HOME with a real version home + real sources, run computeSyncStatus in a
 * subprocess with HOME pointed at the fixture, and assert the mapping.
 *
 * These target the exact bug class that motivated this module: a resource that
 * was synced and then had its SOURCE changed must report `drifted`, not `synced`
 * — the false-positive the old git-based `agents view` checkmark produced.
 */

let testHome: string;
let userDir: string;
let systemDir: string;
let projectDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-status-test-'));
  userDir = path.join(testHome, '.agents');
  systemDir = path.join(userDir, '.system');
  projectDir = path.join(testHome, 'work');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  // Keep the migrator from running on a missing legacy state.
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

/** Create an installed claude version: home dirs + a binary so listInstalledVersions sees it. */
function makeInstalledVersion(version: string): { home: string; cmdsHome: string } {
  const versionDir = path.join(userDir, '.history', 'versions', 'claude', version);
  const home = path.join(versionDir, 'home');
  const cmdsHome = path.join(home, '.claude', 'commands');
  fs.mkdirSync(cmdsHome, { recursive: true });
  const binDir = path.join(versionDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n');
  return { home, cmdsHome };
}

interface Status {
  system: { unknown: boolean; behind: number };
  agents: Array<{
    agent: string;
    version: string;
    everSynced: boolean;
    needsSync: boolean;
    counts: { synced: number; drifted: number; missing: number; orphan: number };
    resources: Array<{ kind: string; name: string; status: string }>;
  }>;
  totals: { drifted: number; missing: number; orphan: number; versionsNeedingSync: number };
}

function runStatus(kinds?: string[]): Status {
  const modulePath = path.resolve(process.cwd(), 'src/lib/sync-status.ts');
  const script = `
    import { computeSyncStatus } from ${JSON.stringify(modulePath)};
    const r = await computeSyncStatus({
      cwd: ${JSON.stringify(projectDir)},
      agents: ['claude'],
      kinds: ${kinds ? JSON.stringify(kinds) : 'undefined'},
    });
    console.log(JSON.stringify(r));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

function statusOf(s: Status, name: string): string | undefined {
  return s.agents[0]?.resources.find((r) => r.kind === 'commands' && r.name === name)?.status;
}

describe('computeSyncStatus — per-resource mapping', () => {
  it('maps synced / drifted / missing / orphan against the real version home', () => {
    const { cmdsHome } = makeInstalledVersion('2.0.0');
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });

    // synced: source and home identical
    fs.writeFileSync(path.join(srcCmds, 'a.md'), 'ALPHA\n');
    fs.writeFileSync(path.join(cmdsHome, 'a.md'), 'ALPHA\n');
    // drifted: THE key case — synced, then the source changed
    fs.writeFileSync(path.join(srcCmds, 'b.md'), 'BETA v2 (changed)\n');
    fs.writeFileSync(path.join(cmdsHome, 'b.md'), 'BETA v1\n');
    // missing: source exists, nothing installed
    fs.writeFileSync(path.join(srcCmds, 'c.md'), 'GAMMA\n');
    // orphan: installed with no source
    fs.writeFileSync(path.join(cmdsHome, 'orphan.md'), 'ORPHAN\n');

    const s = runStatus(['commands']);

    expect(statusOf(s, 'a')).toBe('synced');
    expect(statusOf(s, 'b')).toBe('drifted'); // not a false "synced"
    expect(statusOf(s, 'c')).toBe('missing');
    expect(statusOf(s, 'orphan')).toBe('orphan');

    expect(s.agents[0].counts).toEqual({ synced: 1, drifted: 1, missing: 1, orphan: 1 });
    expect(s.agents[0].needsSync).toBe(true);
    expect(s.totals.versionsNeedingSync).toBe(1);
  });

  it('an orphan alone does NOT flag needsSync (heal never deletes; orphans are prune\'s job)', () => {
    const { cmdsHome } = makeInstalledVersion('2.0.0');
    fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(cmdsHome, 'orphan.md'), 'ORPHAN\n');

    const s = runStatus(['commands']);

    expect(s.agents[0].counts.orphan).toBe(1);
    expect(s.agents[0].counts.drifted + s.agents[0].counts.missing).toBe(0);
    expect(s.agents[0].needsSync).toBe(false);
    expect(s.totals.versionsNeedingSync).toBe(0);
  });

  it('everSynced reflects .sync-manifest.json presence', () => {
    const { home } = makeInstalledVersion('2.0.0');
    fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });

    // No manifest yet → cold.
    expect(runStatus(['commands']).agents[0].everSynced).toBe(false);

    // A valid (v:1) manifest → warm.
    fs.writeFileSync(path.join(home, '.sync-manifest.json'), JSON.stringify({ v: 1, syncedAt: 0 }));
    expect(runStatus(['commands']).agents[0].everSynced).toBe(true);
  });

  it('reports .system freshness as unknown when it is not a git repo', () => {
    makeInstalledVersion('2.0.0');
    const s = runStatus(['commands']);
    expect(s.system.unknown).toBe(true);
    expect(s.system.behind).toBe(0);
  });
});
