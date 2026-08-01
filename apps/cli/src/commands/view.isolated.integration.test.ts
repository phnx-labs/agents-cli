import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `agents view` used to be either/or per agent: the moment ANY managed version
// existed, the "Not Managed by Agents CLI" block stopped rendering. An
// isolated-only install therefore made the user's own globally-installed CLI
// vanish from the listing — the one command they'd run to confirm `--isolated`
// left it alone reported it as gone. Nothing on disk was touched (the isolation
// boundary holds); the report was simply wrong, which reads exactly like damage.
//
// Real CLI, real filesystem, no mocking: drive the built entrypoint against a
// throwaway HOME and read what a user would actually see.
describe.skipIf(process.platform === 'win32')('agents view — isolated installs vs the global CLI', () => {
  let home: string;
  const GLOBAL_VERSION = '0.55.0';

  const versionDir = (v: string) => path.join(home, '.agents', '.history', 'versions', 'codex', v);

  function plantVersion(version: string, { isolated }: { isolated: boolean }) {
    const binDir = path.join(versionDir(version), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(versionDir(version), 'home', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), `#!/bin/sh\necho "codex-cli ${version}"\n`);
    fs.chmodSync(path.join(binDir, 'codex'), 0o755);
    if (isolated) fs.writeFileSync(path.join(versionDir(version), '.isolated'), `${new Date().toISOString()}\n`);
  }

  function view(): string {
    return execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), 'view', 'codex'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, 'npm-global', 'bin')}:${process.env.PATH}`,
        SHELL: '/bin/bash',
        AGENTS_NO_NUDGE: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'view-isolated-'));
    // The user's own globally-installed codex, laid out the way npm does it.
    const pkgBin = path.join(home, 'npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.mkdirSync(path.join(home, 'npm-global', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgBin, 'codex.js'), `#!/bin/sh\necho "codex-cli ${GLOBAL_VERSION}"\n`);
    fs.chmodSync(path.join(pkgBin, 'codex.js'), 0o755);
    fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', path.join(home, 'npm-global', 'bin', 'codex'));
    // `agents view` refuses to run before setup; the gate is just "is ~/.agents/.system a git repo".
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('lists an isolated copy AND the untouched global install, tagging the isolated one', () => {
    plantVersion('9.9.4', { isolated: true });
    const out = view();

    // The isolated copy is listed, and labelled so it can't be mistaken for the
    // install that owns the launcher.
    expect(out).toContain('9.9.4');
    expect(out).toContain('(isolated)');
    // ...and the user's own CLI is still reported, in its own section.
    expect(out).toContain('Not Managed by Agents CLI');
    expect(out).toContain(`${GLOBAL_VERSION} (global)`);
  }, 120_000);

  it('still hides the global row once a NORMAL version takes over the launcher', () => {
    plantVersion('9.9.4', { isolated: false });
    const out = view();

    expect(out).toContain('9.9.4');
    // A non-isolated install DOES own the launcher, so the "global" row would just
    // be our own shim reported back — keep suppressing it, as before this change.
    expect(out).not.toContain('Not Managed by Agents CLI');
    expect(out).not.toContain('(isolated)');
  }, 120_000);

  it('reports the global install alone when nothing is managed', () => {
    const out = view();

    expect(out).toContain('Not Managed by Agents CLI');
    expect(out).toContain(`${GLOBAL_VERSION} (global)`);
    expect(out).not.toContain('(isolated)');
  }, 120_000);
});
