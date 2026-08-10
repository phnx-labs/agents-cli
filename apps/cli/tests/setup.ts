/**
 * Fork-level hermeticity (#910). vitest runs pool:'forks' — this file executes
 * in every fresh fork BEFORE the test file's imports, so the env it pins is
 * what state.ts / secrets/agent.ts / events.ts capture. Without it, a suite
 * run on a dev machine wrote test-fixture `secrets.get` events into the user's
 * real events log and reached the user's real secrets-agent broker (wiping
 * every unlocked bundle pre-#909).
 *
 * These are the DEFAULT posture, not a cage: tests that need a specific
 * posture (a live temp broker, event-content assertions, usage-stamp checks)
 * still override per-test and restore, exactly as they do today — the saved
 * "previous" value they restore is simply the hermetic default.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';
import { seedHermeticE2eWinHost } from './seed-e2e-win-host.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-'));

// Broker: pin the socket dir to a fork-private temp path so nothing in this
// fork — nor any CLI subprocess it spawns with inherited env — can reach the
// user's real broker socket; and turn the broker client integration off as
// the default (the read fast-path, auto-load, and write eviction all honor
// this, see bundles.ts).
process.env.AGENTS_SECRETS_AGENT_DIR = path.join(tmp, 'secrets-agent');
process.env.AGENTS_SECRETS_NO_AGENT = '1';

// Usage stamping writes bundle metadata back to the secret store on reads.
process.env.AGENTS_NO_USAGE_TRACK = '1';

// Events: redirect the sink to a fork-private file. Redirect, not disable —
// events.test.ts / logs.test.ts assert on written content and re-point the
// sink themselves via _resetForTest, which takes precedence over this env.
process.env.AGENTS_EVENTS_PATH = path.join(tmp, 'events.jsonl');

// Devices registry (RUSH-2042): redirect the device registry + ignore-list dir
// to a fork-private temp so device-registry tests can never write fixture
// devices (alpha, bravo, box, …) into the user's real ~/.agents/.history/
// devices. state.ts's getDevicesDir() reads this at call time; a test that
// wants its own isolated registry overrides AGENTS_DEVICES_DIR per-test. This
// is the surgical mirror of AGENTS_EVENTS_PATH / AGENTS_SECRETS_AGENT_DIR — it
// leaves HOME untouched (git and every other HOME consumer behave normally).
process.env.AGENTS_DEVICES_DIR = path.join(tmp, 'devices');

// Live Windows-host e2e (AGENTS_TEST_WIN_HOST) still needs a real DeviceProfile
// for resolveRemoteDevice. Seed the private registry from the real fleet
// registry (or ssh -G) so the hermetic redirect above does not empty the e2e
// host out of existence — that is exactly what made tests-windows-host-e2e
// red after #1572. See tests/seed-e2e-win-host.ts.
const e2eWinHost = process.env.AGENTS_TEST_WIN_HOST?.trim();
if (e2eWinHost) {
  seedHermeticE2eWinHost({
    host: e2eWinHost,
    devicesDir: process.env.AGENTS_DEVICES_DIR,
    realRegistryPath: path.join(
      process.env.HOME ?? os.homedir(),
      '.agents',
      '.history',
      'devices',
      'registry.json',
    ),
  });
}

// NB: AGENTS_DAEMON_DIR is deliberately NOT set here. Tests that spawn a REAL
// daemon (migrate.test.ts, daemon.test.ts) isolate it per-test via a unique
// HOME and read HOME-based daemon paths; a global AGENTS_DAEMON_DIR would be
// inherited by those spawned children (env: {...process.env}) and force them all
// onto one shared daemon dir, colliding on the single-instance guard. The only
// file that writes the daemon dir IN-PROCESS (daemon-self-heal.test.ts) sets
// AGENTS_DAEMON_DIR itself, file-scoped, so its isolation never leaks here.

// Hook shims/cache/logs + the disposable perf warehouse: every hook now
// resolves through a generated shim (pass-through timing for matcher-only
// hooks, see hooks/cache.ts), so any registrar test that calls
// registerHooksToSettings(...) in-process — most of hooks.test.ts, no
// subprocess HOME override — would otherwise write real shim scripts, cache
// files, JSONL logs, and perf samples into the user's actual ~/.agents/.cache.
// state.ts's getHookShimsDir/getHookCacheDir/getLogsDir/getPerfDir all read
// these at call time; never set in production code.
process.env.AGENTS_HOOK_SHIMS_DIR = path.join(tmp, 'hook-shims');
process.env.AGENTS_HOOK_CACHE_DIR = path.join(tmp, 'hook-cache');
process.env.AGENTS_LOGS_DIR = path.join(tmp, 'logs');
process.env.AGENTS_PERF_DIR = path.join(tmp, 'perf');
// Runtime state (~/.agents/.cache/state/) holds the devices-pending sentinels the
// menu bar renders as "NEW DEVICES". AGENTS_DEVICES_DIR already points the device
// registry and ignore list at tmp, so under test both read EMPTY — and any path
// reaching reconcilePendingSentinels then concluded every tailnet node was new and
// wrote those sentinels into the operator's LIVE dir. Running the suite on a dev
// machine surfaced all 20 nodes as NEW DEVICES, registered and ignored alike.
process.env.AGENTS_STATE_DIR = path.join(tmp, 'state');

// Leak tripwire: the REAL events log must not grow while this fork runs.
// CI-only — on a dev machine live agents append to it concurrently, so the
// check would false-positive locally; CI homes are quiet.
const realEventsLog = path.join(process.env.HOME ?? os.homedir(), '.agents', 'events.jsonl');
const sizeBefore = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;

// Leak tripwire (RUSH-2042): the REAL device registry must not change while
// this fork runs. On CI (no concurrent fleet writers) ANY change — a new,
// modified, or removed entry — is a hermeticity breach; a full content compare
// needs no fixture-name allowlist to stay in sync. On a dev machine live fleet
// agents may legitimately update it mid-run, so the check is CI-only.
const realDevicesRegistry = path.join(process.env.HOME ?? os.homedir(), '.agents', '.history', 'devices', 'registry.json');
const devicesRegistryBefore: string | null = fs.existsSync(realDevicesRegistry)
  ? fs.readFileSync(realDevicesRegistry, 'utf-8')
  : null;

// Leak tripwire: the REAL devices-pending sentinels — the menu bar's "NEW
// DEVICES" list — must not change while this fork runs. Same CI-only rule as
// above: a live daemon probe legitimately reconciles this dir every ~3 min on a
// dev machine. The AGENTS_STATE_DIR pin is the actual fix; this catches a code
// path that resolves the sentinel dir some other way.
const realDevicesPending = path.join(
  process.env.HOME ?? os.homedir(), '.agents', '.cache', 'state', 'devices-pending',
);
const devicesPendingBefore: string | null = fs.existsSync(realDevicesPending)
  ? fs.readdirSync(realDevicesPending).sort().join(',')
  : null;

afterAll(() => {
  try {
    if (process.env.CI) {
      const sizeAfter = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;
      if (sizeAfter > sizeBefore) {
        throw new Error(
          `hermeticity leak (#910): the real events log grew by ${sizeAfter - sizeBefore} bytes ` +
          `during this test file (${realEventsLog}). Some code path bypassed AGENTS_EVENTS_PATH.`,
        );
      }

      const devicesRegistryAfter = fs.existsSync(realDevicesRegistry)
        ? fs.readFileSync(realDevicesRegistry, 'utf-8')
        : null;
      if (devicesRegistryAfter !== devicesRegistryBefore) {
        throw new Error(
          `hermeticity leak (RUSH-2042): the real device registry (${realDevicesRegistry}) ` +
          `changed during this test file — a test wrote to it instead of the fork-private ` +
          `AGENTS_DEVICES_DIR. Set AGENTS_DEVICES_DIR (or use the setup default) before ` +
          `importing any state consumer.`,
        );
      }

      const pendingAfter = fs.existsSync(realDevicesPending)
        ? fs.readdirSync(realDevicesPending).sort().join(',')
        : null;
      if (pendingAfter !== devicesPendingBefore) {
        throw new Error(
          `hermeticity leak: the real devices-pending sentinels (${realDevicesPending}) ` +
          `changed during this test file — a test wrote the menu bar's "NEW DEVICES" state ` +
          `instead of the fork-private AGENTS_STATE_DIR. Because AGENTS_DEVICES_DIR makes the ` +
          `registry and ignore list read EMPTY under test, the leaking path marks every ` +
          `tailnet node as new and the operator's ignore list appears to have been lost.`,
        );
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
