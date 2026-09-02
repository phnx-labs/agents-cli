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

  it('refuses the live home ROOT itself (materializer appends the config dir)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-home-root-'));
    tempDirs.push(home);
    // Passing HOME as the output home would land the harness config dir in ~/.claude.
    expect(() => resolveOutputHome(home, process.cwd(), home)).toThrow(MaterializeGuardError);
    expect(() => resolveOutputHome(home, process.cwd(), home)).toThrow(/must not be the live home directory/);
  });

  it('refuses a symlink whose target is the live home ROOT', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-symhome-'));
    tempDirs.push(home);
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-symlink-'));
    tempDirs.push(linkParent);
    const link = path.join(linkParent, 'alias');
    fs.symlinkSync(home, link);
    // The symlink resolves to HOME, so writing under it aliases ~/.claude.
    expect(() => resolveOutputHome(link, process.cwd(), home)).toThrow(/must not be the live home directory/);
  });

  it('refuses a target inside a symlinked-to-HOME ancestor', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-symanc-'));
    tempDirs.push(home);
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-symanc-p-'));
    tempDirs.push(linkParent);
    const link = path.join(linkParent, 'alias');
    fs.symlinkSync(home, link);
    // alias -> HOME, so alias/.claude/x is the live ~/.claude tree.
    const escaped = path.join(link, '.claude', 'nested');
    expect(() => resolveOutputHome(escaped, process.cwd(), home)).toThrow(/live \.claude directory/);
  });

  it('refuses the live ~/.claude even when ~/.claude ITSELF is a symlink (PHNX-3838)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-livelink-'));
    tempDirs.push(home);
    const realClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-realclaude-'));
    tempDirs.push(realClaude);
    // ~/.claude is a symlink pointing at the operator's real claude config dir.
    fs.symlinkSync(realClaude, path.join(home, '.claude'));

    // The symlink's real target IS the live home — must be refused.
    expect(() => resolveOutputHome(realClaude, process.cwd(), home)).toThrow(/live \.claude directory/);
    // Passing ~/.claude (the symlink) itself resolves to the same real target.
    expect(() => resolveOutputHome(path.join(home, '.claude'), process.cwd(), home)).toThrow(/live \.claude directory/);
    // A path inside the real target too.
    expect(() => resolveOutputHome(path.join(realClaude, 'nested'), process.cwd(), home)).toThrow(/live \.claude directory/);
  });

  it('refuses BOTH a DANGLING ~/.claude link and its absent target (PHNX-3838)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-dangling-'));
    tempDirs.push(home);
    // ~/.claude is a symlink to a target that does NOT exist yet. `mkdir -p` on
    // either would follow the link and create the operator's live ~/.claude.
    const absentTarget = path.join(home, 'not-there-yet');
    fs.symlinkSync(absentTarget, path.join(home, '.claude'));

    // The literal alias itself.
    expect(() => resolveOutputHome(path.join(home, '.claude'), process.cwd(), home)).toThrow(/live \.claude directory/);
    // AND the absent target the dangling link points at.
    expect(() => resolveOutputHome(absentTarget, process.cwd(), home)).toThrow(/live \.claude directory/);
  });

  it('refuses the absent target of a RELATIVE, CHAINED dangling ~/.codex link (PHNX-3838)', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-chain-'));
    tempDirs.push(parent);
    const home = path.join(parent, 'home');
    fs.mkdirSync(home);
    // ~/.codex -> hop1 (relative) -> ../evil (relative), and ../evil is absent.
    fs.symlinkSync('hop1', path.join(home, '.codex'));
    fs.symlinkSync('../evil', path.join(home, 'hop1'));
    const chainEnd = path.join(parent, 'evil'); // resolves from home/../evil

    expect(() => resolveOutputHome(path.join(home, '.codex'), process.cwd(), home)).toThrow(/live \.codex directory/);
    expect(() => resolveOutputHome(chainEnd, process.cwd(), home)).toThrow(/live \.codex directory/);
  });

  it('refuses a CASE-equivalent alias of a dangling live ~/.claude on a case-insensitive FS (PHNX-3838)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-casefold-'));
    tempDirs.push(home);
    // ~/.claude dangles to an ABSENT target spelled `Real-Claude`; --output-home
    // uses the spelling-equivalent `real-claude`. On a case-insensitive
    // filesystem (macOS/Windows) both name the SAME file, so `mkdir -p` on the
    // alias re-creates the operator's live ~/.claude in the materialized tree.
    const absentTarget = path.join(home, 'Real-Claude');
    fs.symlinkSync(absentTarget, path.join(home, '.claude'));
    const alias = path.join(home, 'real-claude'); // same file as Real-Claude when case-insensitive

    // CI is Linux (case-sensitive), so force the case-insensitive comparison the
    // real macOS/Windows platform would use — this is exactly what the escape
    // needs and what the current head lets through.
    expect(() => resolveOutputHome(alias, process.cwd(), home, true)).toThrow(MaterializeGuardError);
    expect(() => resolveOutputHome(alias, process.cwd(), home, true)).toThrow(/live \.claude directory/);
  });

  it('does NOT fold case on Linux — a spelling-variant is a DISTINCT dir there (PHNX-3838)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-nofold-'));
    tempDirs.push(home);
    const absentTarget = path.join(home, 'Real-Claude');
    fs.symlinkSync(absentTarget, path.join(home, '.claude'));
    const distinct = path.join(home, 'real-claude'); // a genuinely different dir on a case-sensitive FS

    // With case-sensitive identity (Linux), `real-claude` != `Real-Claude`, so
    // it is a legitimate, non-live output home and must be accepted — folding
    // here would over-reject and break real Linux usage.
    expect(resolveOutputHome(distinct, process.cwd(), home, false)).toBe(path.resolve(distinct));
  });

  it('still allows a non-live directory reached through a benign symlink', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-benign-'));
    tempDirs.push(home);
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-benign-real-'));
    tempDirs.push(real);
    const link = path.join(path.dirname(real), `${path.basename(real)}-link`);
    fs.symlinkSync(real, link);
    tempDirs.push(link);
    const out = path.join(link, 'ephemeral');
    expect(resolveOutputHome(out, process.cwd(), home)).toBe(path.resolve(out));
  });
});
