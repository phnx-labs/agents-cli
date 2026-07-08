import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * End-to-end apply test for the drift-sync flow. The `yes` path must actually
 * reconcile the version home: overwrite a drifted file with its source and
 * install a missing one. No mocks — real heal, real file writes.
 */

let testHome: string;
let userDir: string;
let cmdsHome: string;
let srcCmds: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-sync-test-'));
  userDir = path.join(testHome, '.agents');
  const versionDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0');
  cmdsHome = path.join(versionDir, 'home', '.claude', 'commands');
  srcCmds = path.join(userDir, 'commands');
  fs.mkdirSync(cmdsHome, { recursive: true });
  fs.mkdirSync(srcCmds, { recursive: true });
  fs.mkdirSync(path.join(userDir, '.system'), { recursive: true });
  const binDir = path.join(versionDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

function runYesApply(): { result: string; drifted: string; missingPresent: boolean; missing: string } {
  const modulePath = path.resolve(process.cwd(), 'src/lib/drift-sync.ts');
  const script = `
    import { promptDriftSync } from ${JSON.stringify(modulePath)};
    const r = await promptDriftSync({ cwd: ${JSON.stringify(userDir)}, yes: true, quiet: true });
    console.error(JSON.stringify({ healedVersions: r.healed.length }));
  `;
  // heal resolves against the HOME dir; point HOME at the fixture.
  execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return {
    result: '',
    drifted: fs.readFileSync(path.join(cmdsHome, 'drifted.md'), 'utf-8'),
    missingPresent: fs.existsSync(path.join(cmdsHome, 'missing.md')),
    missing: fs.existsSync(path.join(cmdsHome, 'missing.md'))
      ? fs.readFileSync(path.join(cmdsHome, 'missing.md'), 'utf-8')
      : '',
  };
}

describe('promptDriftSync --yes — apply path', () => {
  it('overwrites a drifted resource with its source and installs a missing one', () => {
    // source of truth
    fs.writeFileSync(path.join(srcCmds, 'drifted.md'), 'ALPHA v2 (source of truth)\n');
    fs.writeFileSync(path.join(srcCmds, 'missing.md'), 'GAMMA (new)\n');
    // home: drifted has stale content, missing is absent
    fs.writeFileSync(path.join(cmdsHome, 'drifted.md'), 'ALPHA v1 (stale)\n');

    const after = runYesApply();

    // drifted was reconciled to the source
    expect(after.drifted.trim()).toBe('ALPHA v2 (source of truth)');
    // missing was installed
    expect(after.missingPresent).toBe(true);
    expect(after.missing.trim()).toBe('GAMMA (new)');
  });
});
