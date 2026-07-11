/**
 * Opt-in end-to-end coverage for the `agents computer --host <win>` path.
 *
 * Unlike ssh-tunnel.test.ts (pure script-builder units), this suite drives the
 * REAL remote runtime against a live Windows box: it pushes the daemon exe over
 * scp, registers + starts the LOGON scheduled task, opens the ssh -L tunnel, and
 * round-trips JSON-RPC over that tunnel. It exists because every reliability bug
 * in this path (type-text corruption, daemon start timeout, ssh echo, remote
 * cleanup gap — see issue #561) was caught only by manual testing, never CI.
 *
 * GATED: the whole suite SKIPS cleanly when AGENTS_TEST_WIN_HOST is unset, so CI
 * stays green with no Windows runner. To run it, point the var at a registered
 * Windows device and build the helper exe first:
 *
 *   bash apps/cli/scripts/build-win.sh
 *   AGENTS_TEST_WIN_HOST=win-mini bun run test -- src/lib/ssh-tunnel.e2e.test.ts
 *
 * Real invocations only — no mocking. The device must be reachable over the same
 * BatchMode key auth `agents ssh` uses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  setupRemoteHelper,
  startRemoteTunnel,
  stopRemoteHelper,
  readRemoteState,
  resolveRemoteDevice,
  hydrateRemoteEnvFromState,
  WIN_HELPER_EXE,
  type RemoteTunnelState,
} from './ssh-tunnel.js';
import { sshExec } from './ssh-exec.js';
import { encodePowerShell } from './browser/drivers/ssh.js';
import { openComputerClient, type ComputerClient, type RPCResponse } from './computer-rpc.js';

const HOST = process.env.AGENTS_TEST_WIN_HOST ?? '';
// describe.skip still evaluates the callback but reports every test as skipped —
// exactly the clean CI skip the issue asks for when no runner is configured.
const suite = HOST ? describe : describe.skip;

// scp of the ~164MB self-contained exe over the network dominates setup; give it
// room. The per-test RPC calls are quick (30s daemon ceiling) but the roundtrip
// polls, so keep those generous too.
const SETUP_TIMEOUT = 600_000;
const RPC_TIMEOUT = 120_000;

// A UIA document read can carry a trailing newline the caller never typed; strip
// one trailing CR/LF so a fidelity compare is against the typed text alone.
function normalizeDoc(s: string): string {
  return s.replace(/\r?\n$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

suite('computer --host live remote (AGENTS_TEST_WIN_HOST)', () => {
  let state: RemoteTunnelState;
  let target: string;
  let client: ComputerClient;

  const unwrap = (r: RPCResponse): Record<string, unknown> => {
    if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
    return (r.result ?? {}) as Record<string, unknown>;
  };

  beforeAll(async () => {
    ({ target } = await resolveRemoteDevice(HOST));

    // Scenario 1: `computer setup --host` — push the exe + register/start the
    // LOGON task. Throws with remote stderr on any hop failure.
    await setupRemoteHelper(HOST);

    // Scenario 2 (part a): `computer start --host` — open the tunnel and confirm
    // the daemon answers `list_apps` over it. startRemoteTunnel throws if the
    // daemon never responds, so a returned state IS the live-tunnel proof.
    state = await startRemoteTunnel(HOST);

    // Point this process's RPC client at the recorded tunnel, exactly as every
    // `--host` verb does, then hold one shared TCP client for the round-trips.
    hydrateRemoteEnvFromState(HOST);
    client = openComputerClient();
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* best effort */
    }
    if (HOST) {
      // Scenario 5-equivalent for the computer path: `stop --host` kills the
      // tunnel and unregisters the remote task. Always run so a live box is left
      // clean even if an assertion above failed.
      await stopRemoteHelper(HOST);
    }
  }, SETUP_TIMEOUT);

  it(
    'setup --host leaves the helper exe on the remote under %LOCALAPPDATA%\\agents',
    () => {
      // Independent proof the push landed — query the remote filesystem directly
      // rather than trusting setupRemoteHelper's own return.
      const script = [
        `$p = Join-Path (Join-Path $env:LOCALAPPDATA 'agents') '${WIN_HELPER_EXE}'`,
        `if (Test-Path -LiteralPath $p) { Write-Output "PRESENT $((Get-Item -LiteralPath $p).Length)" } else { Write-Output 'MISSING' }`,
      ].join('; ');
      const res = sshExec(target, encodePowerShell(script), { timeoutMs: 60_000 });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('PRESENT');
      // The pushed exe is non-trivial (self-contained single file, ~160MB).
      const bytes = Number(res.stdout.trim().split(/\s+/).at(-1));
      expect(bytes).toBeGreaterThan(1_000_000);
    },
    RPC_TIMEOUT,
  );

  it('start --host records a live tunnel the RPC client can reach', () => {
    expect(state.localPort).toBeGreaterThan(0);
    expect(state.tunnelPid).toBeGreaterThan(0);
    expect(readRemoteState(HOST)?.localPort).toBe(state.localPort);
    expect(process.env.COMPUTER_HELPER_TCP).toBe(`127.0.0.1:${state.localPort}`);
  });

  it(
    'screenshot --host returns a non-empty PNG over the tunnel',
    async () => {
      // Full-display capture: no app needed, and the Windows helper always
      // encodes PNG. Proves tunnel + daemon + screencapture end-to-end.
      const res = unwrap(await client.call('screenshot', { display: true }));
      const b64 = res.image_data as string | undefined;
      expect(b64, 'helper returned no image_data').toBeTruthy();
      const png = Buffer.from(b64!, 'base64');
      expect(png.length).toBeGreaterThan(1000);
      // PNG magic: 89 50 4E 47.
      expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    },
    RPC_TIMEOUT,
  );

  it(
    'type-text then get-text round-trips over the tunnel with byte fidelity',
    async () => {
      // Drive Notepad the same way the on-box smoke test does, but through the
      // real --host tunnel: launch -> resolve pid -> focus the edit control ->
      // type -> read back. A unique marker so a stale document can't false-pass.
      const marker = `e2e-host-${process.pid}-${state.localPort}`;
      try {
        unwrap(await client.call('launch_app', { path: 'C:\\Windows\\System32\\notepad.exe' }));

        let pid = 0;
        let elId = '';
        for (let i = 0; i < 30 && !elId; i++) {
          const apps = (unwrap(await client.call('list_apps')).apps as
            | Array<{ pid: number; name?: string; bundle_id?: string }>
            | undefined) ?? [];
          const np = apps.find(
            (a) => /notepad/i.test(a.name ?? '') || /notepad/i.test(a.bundle_id ?? ''),
          );
          if (np) {
            pid = np.pid;
            const desc = unwrap(await client.call('describe', { pid }));
            elId = findEditableId((desc as { tree?: UiaNode }).tree);
          }
          if (!elId) await sleep(300);
        }
        expect(pid, 'notepad pid not found via list_apps').toBeGreaterThan(0);
        expect(elId, 'no Edit/Document element in the notepad UIA tree').toBeTruthy();

        unwrap(await client.call('set_focus', { pid, element_id: elId }));
        unwrap(await client.call('type_text', { text: marker }));

        // SendInput is async into the target's message loop — poll until settled.
        let readBack = '';
        let matched = false;
        for (let i = 0; i < 40; i++) {
          const got = unwrap(await client.call('get_text', { pid, element_id: elId }));
          readBack = normalizeDoc(String(got.text ?? ''));
          if (readBack.includes(marker)) {
            matched = true;
            break;
          }
          await sleep(150);
        }
        expect(matched, `get-text roundtrip mismatch: got ${JSON.stringify(readBack)}`).toBe(true);
      } finally {
        // Leave the remote session clean regardless of assertion outcome.
        sshExec(target, encodePowerShell(`taskkill /IM notepad.exe /F`), { timeoutMs: 30_000 });
      }
    },
    RPC_TIMEOUT,
  );
});

interface UiaNode {
  id?: string;
  role?: string;
  children?: UiaNode[];
}

/** DFS for the first focusable text control's element id in a UIA tree. */
function findEditableId(node: UiaNode | undefined): string {
  if (!node || typeof node !== 'object') return '';
  if (node.id && (node.role === 'Edit' || node.role === 'Document')) return node.id;
  for (const c of node.children ?? []) {
    const found = findEditableId(c);
    if (found) return found;
  }
  return '';
}
