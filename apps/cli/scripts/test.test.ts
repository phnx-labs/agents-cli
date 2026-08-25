import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_SH = path.resolve(__dirname, 'test.sh');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [TEST_SH, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

// The whole reason this script exists (RUSH-3178): the ~13k-test suite must
// never quietly land on the machine someone is using. Every assertion here is
// about that one property — offload is the default, local is opt-in, and an
// unavailable offload target FAILS instead of falling back.
describe('scripts/test.sh — the suite never runs locally by accident', () => {
  it('refuses an unusable --device instead of falling back to local', () => {
    // A name that is not in the registry now fails at the REGISTRY LOOKUP, before
    // any ssh is attempted — the address a device is reached at comes from the
    // registry, not from whatever the local resolver makes of the bare name.
    // What this test pins is the invariant that survives either path: an
    // unusable target aborts, and never silently becomes a local run.
    const r = run(['--device', 'no-such-box-xyz.invalid']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('fails loud and names --device when the offload target is unavailable', () => {
    // A missing offload prerequisite must fail rather than silently run locally.
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-nopath-'));
    const r = run([], { PATH: `${emptyBin}:/usr/bin:/bin` });
    fs.rmSync(emptyBin, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/crabbox is not installed/);
    // It must hand the operator the actionable alternatives, not just die.
    expect(r.stderr).toMatch(/--device/);
    expect(r.stderr).toMatch(/--here/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/running the full suite on THIS machine/i);
  });

  it('forwards vitest args through the DEFAULT offload path (RUSH-3015 mitigation)', () => {
    // Regression guard. The offload branch is the default mode, and it used to
    // ignore VITEST_ARGS entirely -- so the attestation producer's
    // `-- --retry=2 --maxWorkers=2` was silently dropped on every ordinary run,
    // removing the very mitigation that stops a good tree from false-failing.
    // A dropped argument is invisible at runtime, so it needs a test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-forward-'));
    const scripts = path.join(dir, 'apps', 'cli', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(TEST_SH, path.join(scripts, 'test.sh'));

    // Stand-in sandbox.sh records exactly what the offload branch handed it.
    const record = path.join(dir, 'got.txt');
    fs.writeFileSync(
      path.join(scripts, 'sandbox.sh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > ${JSON.stringify(record)}\n`,
    );
    fs.chmodSync(path.join(scripts, 'sandbox.sh'), 0o755);

    // A fake `crabbox` so the branch gets past its installed-check.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'crabbox'), '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(path.join(bin, 'crabbox'), 0o755);

    const r = spawnSync('bash', [path.join(scripts, 'test.sh'), '--', '--retry=2', '--maxWorkers=2'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    expect(r.status, r.stdout + r.stderr).toBe(0);
    const got = fs.readFileSync(record, 'utf-8').trim();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(got).toBe('test --retry=2 --maxWorkers=2');
  });

  it('rejects an unknown flag rather than forwarding it to vitest', () => {
    const r = run(['--oops']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unexpected argument: --oops/);
    // Names the escape hatch so the next person does not guess.
    expect(r.stderr).toMatch(/-- --oops/);
  });

  it('requires a value for --device (never silently offloads to nowhere)', () => {
    const r = run(['--device']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--device needs a machine name/);
  });

  it('refuses the interactive host by name, and says how to override', () => {
    // The registry marks exactly one device `interactive: true` — the laptop
    // someone is sitting at. Naming it as a --device target is almost always a
    // mistake, and silently honoring it is the bug this script exists to stop.
    const interactive = JSON.parse(
      spawnSync('agents', ['devices', 'list', '--json'], { encoding: 'utf-8' }).stdout || '[]',
    ).find((d: { interactive?: boolean }) => d.interactive)?.name;
    if (!interactive) return; // no interactive host registered on this box

    const r = run(['--device', interactive]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is the INTERACTIVE host/);
    expect(r.stderr).toMatch(/--here/);
  });

  it('rejects a device that is not in the registry', () => {
    const r = run(['--device', 'not-a-real-box']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not in the registry/);
  });

  it('rejects a --repo-root that is not a repo checkout', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'testsh-notrepo-'));
    const r = run(['--repo-root', empty, '--device', 'no-such-box-xyz.invalid']);
    fs.rmSync(empty, { recursive: true, force: true });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has no apps\/cli/);
  });
});
