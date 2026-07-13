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

// Leak tripwire: the REAL events log must not grow while this fork runs.
// CI-only — on a dev machine live agents append to it concurrently, so the
// check would false-positive locally; CI homes are quiet.
const realEventsLog = path.join(process.env.HOME ?? os.homedir(), '.agents', 'events.jsonl');
const sizeBefore = fs.existsSync(realEventsLog) ? fs.statSync(realEventsLog).size : 0;

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
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
