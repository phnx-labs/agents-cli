import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// End-to-end isolation boundary for the LAUNCH-path self-heal (ensureAgentRunnable).
// `agents run <agent>@<version>` calls it on every dispatch (commands/exec.ts) and the
// daemon calls it unattended every ~6h (healBrokenDefaultLaunches), so its two mutating
// steps — "adopt another installed version as the default" and "install latest and pin
// it" — are the places where an isolated copy can bleed into the user's normal setup.
//
// Driven in a subprocess with a planted temp HOME: state paths resolve from
// process.env.HOME at module-eval, the pattern used by self-heal.integration.test.ts.
// No mocks — the repair genuinely calls npm (which fails on these synthetic versions,
// whether by 404 online or by network error offline; both land on the same branch).

// POSIX-only: the launch probe resolves node_modules/.bin/<cli> directly on POSIX but
// the `.cmd` wrapper on Windows, where a missing wrapper is deliberately treated as
// healthy — so a "gutted install" can't be planted the same way.
describe.skipIf(process.platform === 'win32')('ensureAgentRunnable — isolation boundary', () => {
  let home: string;

  const versionDir = (version: string) =>
    path.join(home, '.agents', '.history', 'versions', 'codex', version);

  /** Plant a codex version. `runnable: false` = gutted install (wrapper dir, no binary). */
  function plant(version: string, opts: { runnable: boolean; isolated?: boolean }) {
    const dir = versionDir(version);
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
    if (opts.runnable) {
      const bin = path.join(binDir, 'codex');
      fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(bin, 0o755);
    }
    if (opts.isolated) fs.writeFileSync(path.join(dir, '.isolated'), `${new Date().toISOString()}\n`);
  }

  interface Outcome {
    healed: string | null;
    defaultAfter: string | null;
    installedAfter: string[];
    stillIsolated: boolean;
  }

  function runEnsure(target: string, probeIsolationOf: string): Outcome {
    const versionsPath = path.resolve(process.cwd(), 'src/lib/versions.ts');
    const script = `
      import {
        ensureAgentRunnable, getGlobalDefault, listInstalledVersions, isVersionIsolated,
      } from ${JSON.stringify(versionsPath)};
      const healed = await ensureAgentRunnable('codex', ${JSON.stringify(target)});
      console.log('__RESULT__' + JSON.stringify({
        healed,
        defaultAfter: getGlobalDefault('codex'),
        installedAfter: listInstalledVersions('codex'),
        stillIsolated: isVersionIsolated('codex', ${JSON.stringify(probeIsolationOf)}),
      }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    return JSON.parse(out.split('__RESULT__')[1]);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-runnable-iso-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('leaves the normal default alone when an ISOLATED target cannot be repaired', () => {
    plant('9.9.1', { runnable: true });                    // the user's normal default
    plant('9.9.3', { runnable: true });                    // a healthy normal version
    plant('9.9.2', { runnable: false, isolated: true });   // broken isolated copy
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: "9.9.1"\n');

    const r = runEnsure('9.9.2', '9.9.2');

    // Failure is surfaced, not papered over with someone else's install.
    expect(r.healed).toBeNull();
    // The normal default is untouched — this is the whole point of --isolated.
    expect(r.defaultAfter).toBe('9.9.1');
    // No silent adoption of 9.9.3, and no `latest` materialized behind the user's back.
    expect(r.installedAfter.sort()).toEqual(['9.9.1', '9.9.3']);
    // The clean reinstall must not strip the marker: losing it would demote the copy
    // to a normal install, which shim self-heal would then hand a bare `codex` shim.
    expect(r.stillIsolated).toBe(true);
  }, 180_000);

  it('never adopts an ISOLATED version as the fallback default, but still adopts a normal one', () => {
    plant('9.9.1', { runnable: false });                   // broken normal default
    plant('9.9.9', { runnable: true, isolated: true });     // healthy — but isolated
    plant('9.9.3', { runnable: true });                    // healthy normal
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: "9.9.1"\n');

    const r = runEnsure('9.9.1', '9.9.9');

    // Candidates are tried newest-first, so the isolated 9.9.9 is what an unfiltered
    // fallback would reach for. Only the isolation filter keeps it out — promoting it
    // is exactly what `agents use` refuses and what removeVersion excludes.
    expect(r.healed).toBe('9.9.3');
    expect(r.defaultAfter).toBe('9.9.3');
    expect(r.defaultAfter).not.toBe('9.9.9');
    // The isolated copy is untouched and still isolated.
    expect(r.stillIsolated).toBe(true);
  }, 180_000);

  // The last-resort step ("install latest and pin it") reuses the version dir of
  // whatever `latest` resolves to. If the user already holds THAT version as an
  // isolated copy, installing would commandeer it and pinning would hand an
  // isolated install the global default — the leak the candidate filter above
  // blocks, arriving through a different door.
  it('refuses to pin `latest` when the user holds that exact version as an isolated copy', () => {
    const versionsPath = path.resolve(process.cwd(), 'src/lib/versions.ts');
    const latest = execFileSync('npm', ['view', '@openai/codex', 'version'], { encoding: 'utf-8' }).trim();
    expect(latest).toMatch(/^\d+\.\d+\.\d+/);

    plant('9.9.1', { runnable: false });        // broken normal default
    plant(latest, { runnable: true, isolated: true }); // the ONLY other install — isolated
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: "9.9.1"\n');

    const before = fs.readFileSync(path.join(versionDir(latest), '.isolated'), 'utf-8');
    const r = runEnsure('9.9.1', latest);

    // No default is better than an isolated default; the caller reports the failure.
    expect(r.healed).toBeNull();
    expect(r.defaultAfter).toBe('9.9.1');
    expect(r.defaultAfter).not.toBe(latest);
    // Resolved before installing, so the isolated copy was not even rebuilt.
    expect(r.stillIsolated).toBe(true);
    expect(fs.readFileSync(path.join(versionDir(latest), '.isolated'), 'utf-8')).toBe(before);
  }, 300_000);
});
