import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// End-to-end: plant a temp HOME with one installed agent and a symlink launcher that
// shadows the shim, then drive the real runSelfHeal (shims + shadowing + path) in a
// subprocess (state paths resolve from process.env.HOME at module-eval — the pattern
// from doctor-diff.test.ts). No mocks: real shim generation, real launcher adoption,
// real rc-file edit — all confined to the temp home.

// POSIX-only: exercises symlink-launcher adoption (the `shadowing` check is gated to
// darwin/linux) plus a `/bin/echo` symlink and a bash rc-file edit — none of which
// apply on Windows, where PATH lives in the registry and adoption is a no-op.
describe.skipIf(process.platform === 'win32')('runSelfHeal — shims/shadowing/path against a planted home', () => {
  let home: string;
  let binDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-int-'));
    // Installed agent: a claude version dir (only its existence matters here) + default pin.
    fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'claude', '2.0.0'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
    // A launcher symlink that shadows the shim, first on PATH (the grok/claude shape).
    binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync('/bin/echo', path.join(binDir, 'claude'));
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function runTwice(): {
    run1: Report; run2: Report; shimExists: boolean; launcherPointsAtShim: boolean;
  } {
    const modulePath = path.resolve(process.cwd(), 'src/lib/self-heal/registry.ts');
    const shimsPath = path.resolve(process.cwd(), 'src/lib/shims.ts');
    const script = `
      import { runSelfHeal } from ${JSON.stringify(modulePath)};
      import { getShimPath } from ${JSON.stringify(shimsPath)};
      import fs from 'node:fs';
      const opts = { checks: ['shims', 'shadowing', 'path'], mode: 'safe' };
      const run1 = await runSelfHeal(opts);
      const run2 = await runSelfHeal(opts);
      const shim = getShimPath('claude');
      const launcher = ${JSON.stringify(path.join(binDir, 'claude'))};
      let launcherPointsAtShim = false;
      try { launcherPointsAtShim = fs.realpathSync(launcher) === fs.realpathSync(shim); } catch {}
      console.log(JSON.stringify({
        run1, run2,
        shimExists: fs.existsSync(shim),
        launcherPointsAtShim,
      }));
    `;
    // shims dir (HOME/.agents/.cache/shims) is deliberately NOT on PATH; binDir is first.
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}`, SHELL: '/bin/bash' },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    return JSON.parse(out);
  }

  it('regenerates the shim, adopts the symlink launcher, adds PATH — and is idempotent', () => {
    const { run1, run2, shimExists, launcherPointsAtShim } = runTwice();

    const c1 = byId(run1);
    // shim regenerated
    expect(c1.shims.fixed.join(' ')).toContain('claude shim');
    // symlink launcher adopted (not flagged as a real-binary shadow)
    expect(c1.shadowing.fixed.join(' ')).toContain('claude');
    expect(c1.shadowing.needsAttention).toEqual([]);
    // PATH added
    expect(c1.path.fixed.join(' ')).toMatch(/added shims to PATH/i);

    // physical proof
    expect(shimExists).toBe(true);
    expect(launcherPointsAtShim).toBe(true);
    // the rc file actually got the managed line
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8')).toContain('.agents');

    // idempotency: nothing re-written on the second pass
    const c2 = byId(run2);
    expect(c2.shims.fixed).toEqual([]);
    expect(c2.shadowing.fixed).toEqual([]); // already-adopted -> no-op
    expect(c2.path.fixed).toEqual([]);       // already in rc -> no double-append
  });
});

interface CheckR { fixed: string[]; needsAttention: string[]; ok: boolean }
interface Report { checks: { id: string; result: CheckR | null; error?: string }[] }

function byId(r: Report): Record<string, CheckR> {
  const out: Record<string, CheckR> = {};
  for (const c of r.checks) out[c.id] = c.result ?? { fixed: [], needsAttention: [], ok: true };
  return out;
}
