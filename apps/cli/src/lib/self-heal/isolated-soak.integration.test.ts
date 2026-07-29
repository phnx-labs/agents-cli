import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression for a REAL user report: "one of the self-heal mechanisms messed up my
// local installation." Reproduced end-to-end from isolated-only usage, no misuse.
//
// The chain:
//   1. `agents run <agent>@<isolated>` finds the copy broken (partial npm extraction).
//   2. The in-place repair fails (registry unreachable).
//   3. Launch-path self-heal adopts ANOTHER installed version and pins it as the
//      global default.
//   4. That default is the only thing gating the `shadowing` check
//      (`if (!getGlobalDefault(agent)) continue`), which now fires and ADOPTS the
//      user's own launcher — repointing ~/.npm-global/bin/<cli>, an npm-created
//      symlink, at our shim.
//   5. `shims` + `path` then add a bare shim and a PATH entry.
//
// Net effect on the reporter's machine: the globally installed CLI stopped working.
// Every link in that chain has to stay broken, so this test asserts the whole
// pipeline is inert — not just the one step that happened to be patched.
//
// POSIX-only: `shadowing` is gated to darwin/linux, and the npm bin-symlink layout
// and PATH-order problem are POSIX concerns (Windows resolves via the registry).
describe.skipIf(process.platform === 'win32')('isolated-only usage never disturbs a local install', () => {
  let home: string;
  const GOOD = '9.9.4';
  const BROKEN = '9.9.5';

  const versionDir = (v: string) => path.join(home, '.agents', '.history', 'versions', 'codex', v);
  const globalBin = () => path.join(home, 'npm-global', 'bin', 'codex');
  const shimsDir = () => path.join(home, '.agents', '.cache', 'shims');

  function plantIsolated(version: string, { runnable }: { runnable: boolean }) {
    const binDir = path.join(versionDir(version), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(versionDir(version), 'home', '.codex'), { recursive: true });
    if (runnable) {
      fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(binDir, 'codex'), 0o755);
    }
    fs.writeFileSync(path.join(versionDir(version), '.isolated'), `${new Date().toISOString()}\n`);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-soak-'));
    // The user's own globally-installed CLI, laid out the way npm does it: a bin
    // symlink into lib/node_modules. This symlink is what adoption would hijack.
    const pkgBin = path.join(home, 'npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.mkdirSync(path.join(home, 'npm-global', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgBin, 'codex.js'), '#!/bin/sh\necho LOCAL-GLOBAL-CODEX\n');
    fs.chmodSync(path.join(pkgBin, 'codex.js'), 0o755);
    fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', globalBin());
    fs.writeFileSync(path.join(home, '.bashrc'), '# user rc\n');
    // Two isolated copies; the newer one is gutted (wrapper dir, no launch binary).
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    plantIsolated(GOOD, { runnable: true });
    plantIsolated(BROKEN, { runnable: false });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('survives a failed isolated repair plus repeated daemon self-heal passes', () => {
    const versionsPath = path.resolve(process.cwd(), 'src/lib/versions.ts');
    const registryPath = path.resolve(process.cwd(), 'src/lib/self-heal/registry.ts');
    const script = `
      import { ensureAgentRunnable, getGlobalDefault, isVersionIsolated } from ${JSON.stringify(versionsPath)};
      import { runSelfHeal } from ${JSON.stringify(registryPath)};
      // Step 1-2: run the broken isolated copy; the repair cannot succeed.
      const healed = await ensureAgentRunnable('codex', ${JSON.stringify(BROKEN)});
      // Steps 3-5: the daemon's periodic passes, many times over.
      for (let i = 0; i < 6; i++) await runSelfHeal({ mode: 'safe' });
      console.log('__RESULT__' + JSON.stringify({
        healed,
        defaultAfter: getGlobalDefault('codex'),
        goodStillIsolated: isVersionIsolated('codex', ${JSON.stringify(GOOD)}),
        brokenStillIsolated: isVersionIsolated('codex', ${JSON.stringify(BROKEN)}),
      }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        // The user's own launcher is FIRST on PATH — the shadowing condition.
        PATH: `${path.join(home, 'npm-global', 'bin')}:${process.env.PATH}`,
        SHELL: '/bin/bash',
        // Force every npm operation to fail, so the in-place repair cannot recover
        // and self-heal is pushed onto its mutating fallback paths.
        npm_config_registry: 'http://127.0.0.1:9/',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    const r = JSON.parse(out.split('__RESULT__')[1]) as {
      healed: string | null; defaultAfter: string | null;
      goodStillIsolated: boolean; brokenStillIsolated: boolean;
    };

    // The failure is surfaced, not worked around with someone else's install.
    expect(r.healed).toBeNull();
    // No default is recorded — which is also what keeps `shadowing` disarmed.
    expect(r.defaultAfter).toBeNull();
    // Neither copy was demoted by the repair attempt.
    expect(r.goodStillIsolated).toBe(true);
    expect(r.brokenStillIsolated).toBe(true);

    // The user's own launcher still points where npm put it.
    expect(fs.readlinkSync(globalBin())).toBe('../lib/node_modules/@openai/codex/bin/codex.js');
    expect(execFileSync(globalBin()).toString()).toContain('LOCAL-GLOBAL-CODEX');

    // No bare shim, no PATH entry — only the explicit versioned aliases.
    const shims = fs.existsSync(shimsDir()) ? fs.readdirSync(shimsDir()).sort() : [];
    expect(shims).not.toContain('codex');
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8')).not.toContain('.agents/.cache/shims');
    // And the real config dir was never created or adopted.
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  }, 300_000);
});
