import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// bash script under test; the shim-PATH harness below is POSIX-only.
const describeSandbox = process.platform === 'win32' ? describe.skip : describe;

const SANDBOX_SH_PATH = path.resolve(__dirname, 'sandbox.sh');
const SANDBOX_SH = fs.readFileSync(SANDBOX_SH_PATH, 'utf-8');

// Run sandbox.sh with a shim dir FIRST on PATH carrying a fake `agents` (logs
// every invocation to CALL_LOG, exits per FAKE_AGENTS_MODE) and a fake
// `crabbox` (so the dependency probe passes without Hetzner access).
function runSandbox(env: Record<string, string | undefined>): {
  status: number | null;
  out: string;
  calls: string[];
} {
  const shims = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-shims-'));
  const callLog = path.join(shims, 'calls.log');
  fs.writeFileSync(
    path.join(shims, 'agents'),
    `#!/bin/sh
echo "agents $*" >> "${callLog}"
case "\${FAKE_AGENTS_MODE:-ok}" in
  no-bundles) exit 1 ;;
  *) exit 0 ;;
esac
`,
  );
  fs.writeFileSync(path.join(shims, 'crabbox'), `#!/bin/sh\nexit 1\n`);
  fs.chmodSync(path.join(shims, 'agents'), 0o755);
  fs.chmodSync(path.join(shims, 'crabbox'), 0o755);
  try {
    const r = spawnSync('bash', [SANDBOX_SH_PATH, '--', 'true'], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${shims}:${process.env.PATH ?? ''}`,
        HCLOUD_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        SANDBOX_SECRETS_EXEC: undefined,
        ...env,
      },
    });
    const calls = fs.existsSync(callLog)
      ? fs.readFileSync(callLog, 'utf-8').trim().split('\n').filter(Boolean)
      : [];
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls };
  } finally {
    fs.rmSync(shims, { recursive: true, force: true });
  }
}

describeSandbox('sandbox.sh credential loading (RUSH-2774)', () => {
  it('never materializes secrets — no eval of a plaintext export anywhere in the script', () => {
    expect(SANDBOX_SH).not.toContain('secrets export');
    // Values must arrive via injection (the secrets-exec re-exec chain).
    expect(SANDBOX_SH).toContain('secrets exec');
  });

  it('re-enters itself under a chained `agents secrets exec` when tokens are absent', () => {
    const { calls } = runSandbox({ FAKE_AGENTS_MODE: 'ok' });
    // Probe of each candidate bundle with a real resolve...
    expect(calls.some((c) => c.startsWith('agents secrets exec hetzner.com -- true'))).toBe(true);
    // ...then the re-exec chain whose final link re-invokes sandbox.sh itself.
    const chain = calls.find((c) => c.includes('secrets exec hetzner.com --') && c.includes('sandbox.sh'));
    expect(chain).toBeDefined();
  });

  it('CI path: all tokens pre-set in env skips the secrets chain entirely', () => {
    const { calls } = runSandbox({
      HCLOUD_TOKEN: 'ci-token',
      GITHUB_TOKEN: 'ci-gh',
      CLAUDE_CODE_OAUTH_TOKEN: 'ci-claude',
    });
    expect(calls.filter((c) => c.includes('secrets'))).toEqual([]);
  });

  it('bundles load independently: HCLOUD_TOKEN pre-set still resolves the github.com creds', () => {
    // The 2769 review's regression case: gating the whole chain on
    // HCLOUD_TOKEN silently dropped GitHub App token minting for callers with
    // only the Hetzner token in env.
    const { calls } = runSandbox({ HCLOUD_TOKEN: 'ci-token', FAKE_AGENTS_MODE: 'ok' });
    expect(calls.some((c) => c.startsWith('agents secrets exec github.com -- true'))).toBe(true);
    expect(calls.some((c) => c.startsWith('agents secrets exec hetzner.com'))).toBe(false);
  });

  it('skips unreadable bundles instead of dying (the old per-bundle || true tolerance)', () => {
    const { status, out, calls } = runSandbox({ FAKE_AGENTS_MODE: 'no-bundles' });
    // Every probe failed -> no chain, no re-exec; the script proceeds and dies
    // on the empty HCLOUD_TOKEN with its own actionable message.
    expect(calls.some((c) => c.includes('sandbox.sh'))).toBe(false);
    expect(status).not.toBe(0);
    expect(out).toContain('HCLOUD_TOKEN is empty');
  });
});
