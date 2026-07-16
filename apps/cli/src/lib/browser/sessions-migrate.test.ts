import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { foldBrowserSessionsIntoProfiles } from '../migrate.js';

// Exercises the one-shot fold of the legacy GLOBAL browser/sessions/<task> root
// into the per-profile browser/<profile>/sessions/<task> layout: task→profile
// attribution via tasks.json, orphan handling, and idempotency.

let browserDir: string;

function writeTasks(profile: string, taskNames: string[]): void {
  const dir = path.join(browserDir, profile);
  fs.mkdirSync(dir, { recursive: true });
  const state: Record<string, unknown> = {};
  for (const name of taskNames) state[name] = { id: name, name };
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(state));
}

function writeLegacyCapture(task: string, file: string): void {
  const dir = path.join(browserDir, 'sessions', task);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), 'x');
}

beforeEach(() => {
  browserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-sessions-'));
});
afterEach(() => {
  fs.rmSync(browserDir, { recursive: true, force: true });
});

describe('foldBrowserSessionsIntoProfiles', () => {
  it('moves a legacy capture under the profile whose tasks.json claims the task', () => {
    writeTasks('work', ['brave-otter']);
    writeLegacyCapture('brave-otter', '100.png');

    foldBrowserSessionsIntoProfiles(browserDir);

    expect(fs.existsSync(path.join(browserDir, 'work', 'sessions', 'brave-otter', '100.png'))).toBe(true);
    // legacy global root is cleared
    expect(fs.existsSync(path.join(browserDir, 'sessions'))).toBe(false);
  });

  it('routes unattributable tasks to the _legacy pseudo-profile', () => {
    writeTasks('work', ['known-task']);
    writeLegacyCapture('orphan-task', '200.png');

    foldBrowserSessionsIntoProfiles(browserDir);

    expect(fs.existsSync(path.join(browserDir, '_legacy', 'sessions', 'orphan-task', '200.png'))).toBe(true);
    // 'work' had no matching legacy capture, so no sessions/ dir is created for it
    expect(fs.existsSync(path.join(browserDir, 'work', 'sessions'))).toBe(false);
  });

  it('is idempotent and no-ops when there is no legacy global sessions root', () => {
    writeTasks('work', ['t1']);
    writeLegacyCapture('t1', '1.png');

    foldBrowserSessionsIntoProfiles(browserDir);
    const dest = path.join(browserDir, 'work', 'sessions', 't1', '1.png');
    expect(fs.existsSync(dest)).toBe(true);

    // Second run: legacy root gone → clean no-op, destination untouched.
    expect(() => foldBrowserSessionsIntoProfiles(browserDir)).not.toThrow();
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('merges into a pre-existing destination and preserves nested recordings/ (no stranding)', () => {
    // The collision case: a new capture already landed in the per-profile dir
    // before migration runs, and the legacy dir has a top-level file plus a
    // nested recordings/ subdir. A plain file-move would EISDIR on the dir and
    // silently strand the legacy captures; moveDirOnce must merge them in.
    writeTasks('work', ['shared-task']);
    // pre-existing new-layout capture at the destination
    const destDir = path.join(browserDir, 'work', 'sessions', 'shared-task');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'new.png'), 'new');
    // legacy capture with a top-level file and a nested recordings/ file
    writeLegacyCapture('shared-task', 'old.png');
    const legacyRec = path.join(browserDir, 'sessions', 'shared-task', 'recordings');
    fs.mkdirSync(legacyRec, { recursive: true });
    fs.writeFileSync(path.join(legacyRec, 'old.webm'), 'rec');

    foldBrowserSessionsIntoProfiles(browserDir);

    expect(fs.existsSync(path.join(destDir, 'new.png'))).toBe(true);           // kept
    expect(fs.existsSync(path.join(destDir, 'old.png'))).toBe(true);           // merged in
    expect(fs.existsSync(path.join(destDir, 'recordings', 'old.webm'))).toBe(true); // nested merged in
    // nothing stranded at the legacy root
    expect(fs.existsSync(path.join(browserDir, 'sessions', 'shared-task'))).toBe(false);
  });

  it('does not treat the shared sessions/ dir name as a profile owner', () => {
    // A capture whose task name collides with nothing still folds cleanly; the
    // reserved 'sessions' and '_legacy' dir names are never scanned for tasks.json.
    writeLegacyCapture('lonely-task', '1.png');
    foldBrowserSessionsIntoProfiles(browserDir);
    expect(fs.existsSync(path.join(browserDir, '_legacy', 'sessions', 'lonely-task', '1.png'))).toBe(true);
  });
});
