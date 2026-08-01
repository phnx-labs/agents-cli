/**
 * Fork-level hermeticity (#910, RUSH-2042). vitest runs pool:'forks' — this
 * file executes in every fresh fork BEFORE the test file's imports, so the env
 * it pins is what state.ts / secrets/agent.ts / events.ts capture. Without it,
 * a suite run on a dev machine wrote test-fixture `secrets.get` events into the
 * user's real events log and reached the user's real secrets-agent broker
 * (wiping every unlocked bundle pre-#909).
 *
 * Home root (RUSH-2042): we pin HOME to a fork-private temp here, before any
 * import runs, so every ~/.agents/* path state.ts derives at module-load
 * resolves into the hermetic temp tree. In particular getDevicesRegistryPath()
 * points at <tmp>/.agents/.history/devices/registry.json — so fixture devices
 * written by device-registry tests can never reach the user's real registry.
 *
 * We pin HOME (not a fork-global AGENTS_TEST_HOME) deliberately: HOME-override
 * is the isolation mechanism tests already use, so pinning HOME keeps a per-test
 * `process.env.HOME = <tmp>` override working (a global AGENTS_TEST_HOME would
 * win over it and silently redirect those tests to the fork root). state.ts
 * still reads AGENTS_TEST_HOME ahead of HOME, so a test that wants a surgical
 * override without touching HOME can set it; individual test files that need
 * their own isolated registry (e.g. registry.test.ts, reachability.test.ts)
 * set it to their own mkdtemp before the dynamic import of any state consumer.
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

// Capture the REAL home BEFORE we override HOME — the leak tripwires below must
// check the user's actual registry / events log, not the hermetic temp.
const realHome = process.env.HOME ?? os.homedir();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-'));

// Home root: pin HOME to a fork-private temp so every ~/.agents/* path derived
// in state.ts resolves inside the hermetic tree by default (RUSH-2042). Must be
// set BEFORE any import chain reaches state.ts. Individual tests that need their
// own isolated root still override HOME before a dynamic import (or set the
// surgical AGENTS_TEST_HOME, which state.ts honors ahead of HOME) — exactly as
// they do today, the saved "previous" value they restore being this hermetic
// default. Pinning HOME (not a global AGENTS_TEST_HOME) keeps HOME-override the
// single isolation mechanism, so tests that resolve state paths via a per-test
// HOME are not silently redirected to a fork-global root.
process.env.HOME = tmp;

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

// ─── Leak tripwires ───────────────────────────────────────────────────────────
// (realHome was captured at the top, before HOME was overridden.)

// Events leak: the REAL events log must not grow while this fork runs.
// CI-only — on a dev machine live agents append to it concurrently.
const realEventsLog = path.join(realHome, '.agents', 'events.jsonl');
const eventsLogSizeBefore = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;

// Device registry leak (RUSH-2042): the REAL device registry must not be
// written during the suite — fixture device names (alpha, bravo, box, …) must
// never appear in the user's real fleet. Checked on every run (not CI-only)
// because the damage is silent and long-lasting: leaked fixtures pollute
// `agents devices list` and `fleet ping` until manually removed.
const realDevicesRegistry = path.join(realHome, '.agents', '.history', 'devices', 'registry.json');
const devicesRegistryBefore: string | null = fs.existsSync(realDevicesRegistry)
  ? fs.readFileSync(realDevicesRegistry, 'utf-8')
  : null;

// Known fixture device names from the test suite. Any of these appearing in
// the real registry after the suite indicates a hermeticity breach.
const FIXTURE_DEVICE_NAMES = new Set([
  'alpha', 'bravo', 'charlie', 'delta', 'echo',
  'box', 'box-a', 'box-b', 's1', 'worker',
  'gpu-box', 'gpu-dev', 'winbox', 'test-cockpit',
  'iphone', 'ipad', 'my-iphone', 'my-ipad',
  'mac-mini-test', 'win-mini-test',
]);

afterAll(() => {
  try {
    if (process.env.CI) {
      // Events leak check (CI-only — dev machines have concurrent appenders).
      const eventsLogSizeAfter = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;
      if (eventsLogSizeAfter > eventsLogSizeBefore) {
        throw new Error(
          `hermeticity leak (#910): the real events log grew by ${eventsLogSizeAfter - eventsLogSizeBefore} bytes ` +
          `during this test file (${realEventsLog}). Some code path bypassed AGENTS_EVENTS_PATH.`,
        );
      }
    }

    // Device registry leak check (RUSH-2042) — always, not CI-only.
    // Only flag fixture device names that are NEWLY present (not in the snapshot
    // taken before the test ran). This avoids false positives when the user's
    // real fleet happens to include devices with the same names as test fixtures
    // (e.g. box, alpha, worker), or when concurrent fleet agents update the
    // registry during the test run.
    if (fs.existsSync(realDevicesRegistry)) {
      const devicesRegistryAfter = fs.readFileSync(realDevicesRegistry, 'utf-8');
      if (devicesRegistryAfter !== devicesRegistryBefore) {
        let parsedBefore: Record<string, unknown> = {};
        let parsedAfter: Record<string, unknown> = {};
        try { parsedBefore = JSON.parse(devicesRegistryBefore ?? '{}'); } catch { /* ok */ }
        try { parsedAfter = JSON.parse(devicesRegistryAfter); } catch { /* ok */ }
        // Newly added keys only — keys present in after but not in the pre-test snapshot.
        const newKeys = Object.keys(parsedAfter).filter((k) => !(k in parsedBefore));
        // On CI there are no concurrent fleet writers, so ANY newly-added device is a
        // hermeticity breach — not just the names we happened to enumerate; this closes
        // the gap where a fixture named outside FIXTURE_DEVICE_NAMES would leak silently.
        // On a dev machine, live fleet agents may legitimately add real devices during
        // the run, so fall back to flagging only known fixture names to avoid false
        // positives (FIXTURE_DEVICE_NAMES is the dev-side allowlist for exactly this).
        const leaked = process.env.CI ? newKeys : newKeys.filter((name) => FIXTURE_DEVICE_NAMES.has(name));
        if (leaked.length > 0) {
          throw new Error(
            `hermeticity leak (RUSH-2042): device(s) [${leaked.join(', ')}] were written ` +
            `into the real device registry (${realDevicesRegistry}) during the suite. ` +
            `Set AGENTS_TEST_HOME (or override HOME) in the test file before importing any state consumer.`,
          );
        }
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
