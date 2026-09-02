import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MaterializeGuardError,
  assertExactHarnessVersion,
  assertPortableHarness,
  resolveOutputHome,
} from './output-home.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('assertPortableHarness', () => {
  it('accepts the three portable homes', () => {
    expect(assertPortableHarness('claude')).toBe('claude');
    expect(assertPortableHarness('codex')).toBe('codex');
    expect(assertPortableHarness('opencode')).toBe('opencode');
  });

  it('rejects a non-portable harness, naming it', () => {
    expect(() => assertPortableHarness('gemini')).toThrow(MaterializeGuardError);
    expect(() => assertPortableHarness('gemini')).toThrow(/Unsupported capability.*gemini/i);
  });
});

describe('assertExactHarnessVersion', () => {
  it('accepts an exact version', () => {
    expect(assertExactHarnessVersion('2.1.0')).toBe('2.1.0');
  });

  it('rejects @latest and empty', () => {
    expect(() => assertExactHarnessVersion('latest')).toThrow(/Invalid harness version/);
    expect(() => assertExactHarnessVersion('')).toThrow(/Invalid harness version/);
  });
});

describe('resolveOutputHome', () => {
  it('rejects a path with a .. segment', () => {
    expect(() => resolveOutputHome('/tmp/out/../escape')).toThrow(MaterializeGuardError);
    expect(() => resolveOutputHome('/tmp/out/../escape')).toThrow(/Path escape/);
  });

  it('refuses the live ~/.claude directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-home-'));
    tempDirs.push(home);
    const live = path.join(home, '.claude');
    fs.mkdirSync(live);
    expect(() => resolveOutputHome(live, process.cwd(), home)).toThrow(/Path escape/);
    expect(() => resolveOutputHome(path.join(live, 'nested'), process.cwd(), home)).toThrow(/Path escape/);
  });

  it('returns an absolute path for a safe target', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-ok-'));
    tempDirs.push(home);
    const out = path.join(home, 'ephemeral');
    expect(resolveOutputHome(out, process.cwd(), home)).toBe(path.resolve(out));
  });
});
