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
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
