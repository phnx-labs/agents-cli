// Guard: every `vscode` module mock in the tree must be built by vscodeDouble.
//
// bun's mock registry is process-global and last-registration-wins, so a single
// hand-rolled partial double silently strips API constants from every other
// test file in the same run. That is not a local failure — it shows up as a
// different file's assertions throwing, which is exactly how the Cmd+W teardown
// tests went red in the suite while passing standalone. This test fails on the
// next hand-rolled one instead.

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { VSCODE_API_CONSTANTS, vscodeDouble } from './vscodeDouble';

const SRC = path.join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('vscodeDouble', () => {
  test('merges the shared API constants under the caller surface', () => {
    const double = vscodeDouble({ window: { showErrorMessage: () => {} } });
    expect(double.TerminalExitReason.User).toBe(3);
    expect(double.ConfigurationTarget.Global).toBe(1);
    expect(typeof double.window.showErrorMessage).toBe('function');
  });

  test('every vscode module mock in the tree is built by vscodeDouble', () => {
    // Counted, not substring-matched: a registration is compliant only when it
    // matches the canonical factory EXACTLY. A looser "does this text contain
    // vscodeDouble(" check passes on a registration that merely mentions it in
    // a comment, and a quote-agnostic search is needed because `"vscode"` is
    // just as valid a specifier as `'vscode'`. Any registration the strict
    // pattern misses makes the counts differ, which flags the file.
    const ANY_REGISTRATION = /mock\.module\(\s*['"]vscode['"]/g;
    const CANONICAL_REGISTRATION = /mock\.module\(\s*['"]vscode['"]\s*,\s*\(\)\s*=>\s*vscodeDouble\(/g;

    const offenders = sourceFiles(SRC)
      .filter((file) => file !== path.join(__dirname, 'vscodeDouble.test.ts'))
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        const all = text.match(ANY_REGISTRATION)?.length ?? 0;
        const canonical = text.match(CANONICAL_REGISTRATION)?.length ?? 0;
        return all !== canonical;
      })
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  test('the mirrored TerminalExitReason values match the VS Code API', () => {
    // Stable since API 1.77; terminalReadiness compares against .User.
    expect(VSCODE_API_CONSTANTS.TerminalExitReason).toEqual({
      Unknown: 0,
      Shutdown: 1,
      Process: 2,
      User: 3,
      Extension: 4,
    });
  });
});
