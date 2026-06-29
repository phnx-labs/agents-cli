/**
 * Tests for the hook doc-sidecar fix in `listHookEntriesFromDir` (hooks.ts).
 *
 * A `.md`/`.rst` sibling of a hook script (e.g. `git-guard.md` next to
 * `git-guard.sh`) is human documentation the hook never reads — NOT a runtime
 * data file. Treating it as the hook's `dataFile` made the installer's correct
 * omission of docs look like perpetual drift in `agents doctor`. Structured
 * siblings (`.yaml`/`.json`/...) are still real data files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listHookEntriesFromDir } from '../src/lib/hooks.js';

let TMP: string;
beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-sidecar-')); });
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

function write(name: string, content = '#!/bin/sh\n'): void {
  fs.writeFileSync(path.join(TMP, name), content);
}

describe('listHookEntriesFromDir — doc sidecars', () => {
  it('does NOT treat a .md doc sibling as the hook dataFile', () => {
    write('git-guard.sh');
    write('git-guard.md', '# docs\n');
    const entries = listHookEntriesFromDir(TMP);
    const g = entries.find((e) => e.name === 'git-guard');
    expect(g).toBeDefined();
    expect(g!.scriptPath).toBe(path.join(TMP, 'git-guard.sh'));
    expect(g!.dataFile).toBeUndefined();
  });

  it('still treats a structured .yaml sibling as a real dataFile', () => {
    write('promptcut.sh');
    write('promptcut.yaml', 'a: 1\n');
    const entries = listHookEntriesFromDir(TMP);
    const p = entries.find((e) => e.name === 'promptcut');
    expect(p?.dataFile).toBe(path.join(TMP, 'promptcut.yaml'));
  });

  it('a lone README.md (no script) is not a hook at all', () => {
    write('README.md', '# readme\n');
    expect(listHookEntriesFromDir(TMP)).toHaveLength(0);
  });
});
