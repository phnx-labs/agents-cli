/**
 * Verifies the windowId formula used by foreman.registry to slice
 * `~/.agents/.cache/terminals/live-terminals.json` per VS Code window.
 *
 * Background: VSCodium is a telemetry-stripped Code-OSS fork. Its
 * `vscode.env.sessionId` returns the literal placeholder `"someValue.sessionId"`
 * for EVERY window (see
 * `/Applications/VSCodium.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`,
 * which defines `this.sessionId = "someValue.sessionId"` for the redacted
 * telemetry constructor). The current production formula in
 * `extension/src/vscode/foreman.registry.ts:44`:
 *
 *     ownWindowId = `${vscode.env.sessionId || process.pid}`;
 *
 * collapses every VSCodium window onto the same key, so each window's slice
 * clobbers the others. The proposed fix lives in
 * `extension/src/core/foreman.windowId.ts`: mix `process.pid` in
 * unconditionally, since each VS Code / Cursor / Codium window runs its own
 * extension-host process with a distinct PID.
 *
 * The end-to-end tests below spawn real subprocesses with real PIDs — no
 * mocks — and prove (a) the current formula collides, (b) the proposed
 * formula does not.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { computeWindowId } from './foreman.windowId';

const VSCODIUM_PLACEHOLDER = 'someValue.sessionId';

// The current production formula, inlined so we can demonstrate the bug
// without changing source files.
function computeWindowIdCurrent(sessionId: string | undefined, pid: number): string {
  return `${sessionId || pid}`;
}

describe('current production formula — the bug', () => {
  test('VSCodium placeholder collides across windows', () => {
    const a = computeWindowIdCurrent(VSCODIUM_PLACEHOLDER, 1922);
    const b = computeWindowIdCurrent(VSCODIUM_PLACEHOLDER, 3457);
    expect(a).toBe(VSCODIUM_PLACEHOLDER);
    expect(b).toBe(VSCODIUM_PLACEHOLDER);
    expect(a).toBe(b); // collision
  });

  test('non-redacted sessionId is unique on its own (real VS Code is fine)', () => {
    const a = computeWindowIdCurrent('a1b2c3d4-1111-2222-3333-444455556666', 1000);
    const b = computeWindowIdCurrent('e5f6a7b8-9999-8888-7777-666655554444', 2000);
    expect(a).not.toBe(b);
  });
});

describe('proposed fix in core/foreman.windowId.ts', () => {
  test('VSCodium placeholder no longer collides when pid is mixed in', () => {
    const a = computeWindowId(VSCODIUM_PLACEHOLDER, 1922);
    const b = computeWindowId(VSCODIUM_PLACEHOLDER, 3457);
    expect(a).not.toBe(b);
    expect(a.endsWith('-1922')).toBe(true);
    expect(b.endsWith('-3457')).toBe(true);
  });

  test('still unique when sessionId differs (real VS Code path)', () => {
    const a = computeWindowId('a1b2c3d4', 1000);
    const b = computeWindowId('e5f6a7b8', 2000);
    expect(a).not.toBe(b);
  });

  test('handles undefined sessionId without throwing', () => {
    const a = computeWindowId(undefined, 1000);
    const b = computeWindowId(undefined, 2000);
    expect(a).not.toBe(b);
  });
});

/**
 * End-to-end multi-process test. Two real child node processes each write a
 * registry slice, both using the SAME placeholder sessionId — exactly the
 * VSCodium production scenario. The parent then asserts how many slices
 * survive in the file.
 *
 * No mocks: the children run as separate OS processes with distinct
 * `process.pid` values, so this exercises real-world identity behavior.
 */
describe('end-to-end: real two-process registry write', () => {
  function buildWriter(formulaSrc: string): string {
    // With `node -e <code>`, user args land at argv[1]+ (no script-path slot).
    return `
      const fs = require('fs');
      const sessionId = process.argv[1];
      const file = process.argv[2];
      const computeWindowId = ${formulaSrc};

      function read() {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
      }
      function atomicWrite(reg) {
        const tmp = file + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
        fs.renameSync(tmp, file);
      }

      // A few read-modify-write rounds to mimic publish-on-event behavior.
      for (let i = 0; i < 3; i++) {
        const reg = read();
        reg[computeWindowId(sessionId, process.pid)] = {
          at: new Date().toISOString(),
          entries: [{ sessionId: 'sess-' + process.pid + '-' + i, pid: 99000 + process.pid + i, kind: 'claude' }],
        };
        atomicWrite(reg);
      }

      process.stdout.write(String(process.pid));
    `;
  }

  test('current (buggy) formula produces ONE slice — both windows collapsed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-windowid-bug-'));
    const registryFile = path.join(tmpDir, 'live-terminals.json');

    try {
      const script = buildWriter('(sid, pid) => String(sid || pid)');
      spawnSync('node', ['-e', script, VSCODIUM_PLACEHOLDER, registryFile], { encoding: 'utf8' });
      spawnSync('node', ['-e', script, VSCODIUM_PLACEHOLDER, registryFile], { encoding: 'utf8' });

      const reg = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      const keys = Object.keys(reg);
      expect(keys.length).toBe(1);
      expect(keys[0]).toBe(VSCODIUM_PLACEHOLDER);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('proposed formula produces TWO slices — both windows visible', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-windowid-fix-'));
    const registryFile = path.join(tmpDir, 'live-terminals.json');

    try {
      const script = buildWriter("(sid, pid) => `${sid ?? 'no-session'}-${pid}`");
      const c1 = spawnSync('node', ['-e', script, VSCODIUM_PLACEHOLDER, registryFile], { encoding: 'utf8' });
      const c2 = spawnSync('node', ['-e', script, VSCODIUM_PLACEHOLDER, registryFile], { encoding: 'utf8' });

      expect(c1.status).toBe(0);
      expect(c2.status).toBe(0);
      const pid1 = parseInt(c1.stdout.trim(), 10);
      const pid2 = parseInt(c2.stdout.trim(), 10);
      expect(pid1).not.toBe(pid2);

      const reg = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      const keys = Object.keys(reg);
      expect(keys.length).toBe(2);
      expect(keys).toContain(`${VSCODIUM_PLACEHOLDER}-${pid1}`);
      expect(keys).toContain(`${VSCODIUM_PLACEHOLDER}-${pid2}`);

      const e1 = reg[`${VSCODIUM_PLACEHOLDER}-${pid1}`].entries;
      const e2 = reg[`${VSCODIUM_PLACEHOLDER}-${pid2}`].entries;
      expect(e1.length).toBeGreaterThan(0);
      expect(e2.length).toBeGreaterThan(0);
      expect(e1[0].sessionId).not.toBe(e2[0].sessionId);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
