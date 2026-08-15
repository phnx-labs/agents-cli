import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Completeness guard for the isolation boundary.
 *
 * The boundary used to be a convention: every code path that could adopt an agent had
 * to remember to check `isVersionIsolated` first. It leaked three times that way
 * (#1412, #1423, #1439) — three different call sites, one root cause. Enforcing it
 * inside the primitives makes it a property of the code instead.
 *
 * That only holds while the primitive list is complete. This test pins the list, so
 * adding a seventh way to reach the user's launcher/config without a gate fails here
 * rather than silently reopening the hole a year from now.
 */
describe('isolation boundary — the gate is on every adopting primitive', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf-8');

  // Every primitive that can carry an agent across the boundary, and the file it
  // lives in. Adding one here without a gate fails the assertion below.
  const GATED: Array<{ fn: string; file: string }> = [
    { fn: 'createShim', file: 'src/lib/shims.ts' },
    { fn: 'switchConfigSymlink', file: 'src/lib/shims.ts' },
    { fn: 'switchHomeFileSymlinks', file: 'src/lib/shims.ts' },
    { fn: 'adoptShadowingLauncher', file: 'src/lib/shims.ts' },
    { fn: 'setGlobalDefault', file: 'src/lib/installations/versions.ts' },
  ];

  it.each(GATED)('$fn calls assertIsolationBoundary before doing anything', ({ fn, file }) => {
    const src = read(file);
    const start = src.indexOf(`export function ${fn}`) >= 0
      ? src.indexOf(`export function ${fn}`)
      : src.indexOf(`export async function ${fn}`);
    expect(start, `${fn} not found in ${file}`).toBeGreaterThan(-1);
    // Look only at the function's opening stretch — the gate must come before work.
    const head = src.slice(start, start + 1400);
    expect(head).toContain('assertIsolationBoundary');
  });

  it('no OTHER exported function in shims.ts writes to the real config dir ungated', () => {
    const src = read('src/lib/shims.ts');
    // getAgentConfigPath() resolves the user's real ~/.<agent>. Any exported function
    // that both resolves it and mutates the filesystem is a boundary crossing.
    const MUTATORS = /\b(symlinkSync|renameSync|rmSync|unlinkSync|cpSync|writeFileSync)\s*\(/;
    // Bound each body at the next function declaration of ANY kind. Slicing only to
    // the next EXPORTED one swallows the private helpers in between and pins their
    // mutations on whichever export happened to precede them — which reported
    // `getConfigSymlinkVersion` (lstat + readlink, no writes) as an offender.
    const decls = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
    const offenders: string[] = [];
    for (let i = 0; i < decls.length; i++) {
      const name = decls[i][1];
      if (!decls[i][0].startsWith('export')) continue;
      const body = src.slice(decls[i].index!, decls[i + 1]?.index ?? src.length);
      if (!body.includes('getAgentConfigPath(')) continue;
      if (!MUTATORS.test(body)) continue;
      if (body.includes('assertIsolationBoundary')) continue;
      offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('no file outside the gated primitives hand-rolls config-dir adoption', () => {
    // The first version of this test scanned only shims.ts — which is exactly why
    // setup.ts's second, hand-rolled adoption (rename + symlink inline, never calling
    // switchConfigSymlink) went unnoticed: it bypassed every primitive gate. Scan the
    // whole command/lib surface for the adoption SHAPE instead of trusting that all
    // adoption goes through the primitives.
    const roots = ['src/commands', 'src/lib'];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.resolve(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) files.push(rel);
      }
    };
    roots.forEach(walk);

    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      // Adoption's signature is precise: MOVE the user's real config dir somewhere
      // else. Matching "renames something, and mentions configDir" is too loose — it
      // flagged migrate.ts, which only repoints an already-symlinked config for an
      // agent that has a recorded default pin (something a protected agent cannot
      // have) and never moves a real directory. Match the move itself.
      if (!/renameSync\(\s*(configDir|getAgentConfigPath\()/.test(src)) continue;
      if (src.includes('assertIsolationBoundary')) continue;
      offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the predicate ignores scaffolding, so an adopting path cannot disarm it', () => {
    // `isIsolationProtected` reads the versions dir. An adopting path that creates
    // `<version>/home` before adopting would, if bare dirs counted, flip protection
    // off with its own first line and then sail through every gate. Counting only
    // real installs (node_modules/ or package.json present) closes that.
    const src = read('src/lib/shims.ts');
    const start = src.indexOf('export function isIsolationProtected');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/node_modules|package\.json/);
  });

  it('the predicate is derived from the .isolated markers, not from stored config', () => {
    // Protection must not depend on a setting someone can leave in the wrong state —
    // it is computed from what is actually installed.
    const src = read('src/lib/shims.ts');
    const start = src.indexOf('export function isIsolationProtected');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toContain('isInstalledVersionIsolated');
    expect(body).not.toContain('readMeta');
  });
});
