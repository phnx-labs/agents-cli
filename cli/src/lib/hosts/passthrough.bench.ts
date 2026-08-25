/**
 * Benchmark for the `--device` passthrough bootstrap — the cost every named CLI
 * invocation used to pay before RUSH-2374, and the residual cost of the routed
 * path after it.
 *
 * `src/bootstrap.ts:1041-1051` (primary site; also `:976` and `:1106` on the
 * spellcheck re-route paths) used to run, for EVERY invocation that names a
 * command and is not `--help`/`--version`:
 *
 *   const { maybeRunOnHost } = await import('./lib/hosts/passthrough.js');
 *   if (await maybeRunOnHost(requestedCommand, passedArgs)) { … }
 *
 * That happened before command registration (`registerEagerForRequest`,
 * `bootstrap.ts:1064`), so it was serial cold-start latency on `agents view`,
 * `agents sync`, `agents skills list` — every one of which passes no routing
 * flag and got `false` back from `maybeRunOnHost:473`.
 *
 * RUSH-2374 gates that import on `hasHostRoutingFlag(passedArgs)` (leaf:
 * `routing-flag.ts`), so the no-flag majority path never loads this module.
 * This bench still measures the two costs separately so a regression that
 * re-introduces the ungated import, or grows the routed graph, is visible:
 *
 *  1. **module graph** — what `await import('./lib/hosts/passthrough.js')`
 *     costs cold, measured against a same-flag `node` baseline in a fresh
 *     process (`dist/` is the artifact the shipped CLI actually loads).
 *  2. **function body** — what `maybeRunOnHost` / `hasHostRoutingFlag` cost
 *     once the graph is warm, across realistic argvs on both the no-flag path
 *     and the flag-present early-return branches.
 *
 * Only side-effect-free branches are exercised: the no-flag return at
 * `passthrough.ts:473`, the `OWN_HOST_COMMANDS` return at `:480` and the
 * unknown-command return at `:514`. No branch here opens an SSH connection,
 * loads the device registry, or writes anything — the bench is safe to run on
 * any box.
 *
 * No existing bench covered this path before this file. `index.bench.ts` covers
 * the OTHER two per-invocation entry costs (`checkForUpdates` bootstrap.ts:618
 * and `spawnDetachedSync` bootstrap.ts:1142) and `hosts/dispatch.bench.ts`
 * covers host resolution and SSH command-building — i.e. what runs AFTER
 * `maybeRunOnHost` decides to route. Neither imports `passthrough.ts`. One
 * bench file per source file is this package's existing layout
 * (`brand.bench.ts`, `events.bench.ts`, `exec.bench.ts`,
 * `hosts/dispatch.bench.ts`, `session/db.bench.ts`, …), so this sits beside
 * `passthrough.ts`.
 *
 * Not run by `vitest run`: `vitest.config.ts:18` includes only `*.test.ts`, so
 * this file adds no CI assertion and no flakiness. It IS type-checked, by
 * `typecheck:bench` (package.json:60, globs `src/lib/**\/*.bench.ts`). Run it:
 *
 *   npx vitest bench --run src/lib/hosts/passthrough.bench.ts   # from cli
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { bench, describe } from 'vitest';
import { maybeRunOnHost, flagValue } from './passthrough.js';
import { hasHostRoutingFlag } from './routing-flag.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib/hosts -> cli
const cliRoot = path.resolve(here, '../../..');
const distPassthrough = path.join(cliRoot, 'dist/lib/hosts/passthrough.js');
const distRoutingFlag = path.join(cliRoot, 'dist/lib/hosts/routing-flag.js');

// Fail loud rather than silently skipping: a cold-import number measured
// against a missing artifact would be meaningless.
if (!fs.existsSync(distPassthrough)) {
  throw new Error(
    `passthrough.bench.ts needs the built artifact at ${distPassthrough}. ` +
      `Build it first: bash scripts/build.sh (from cli).`,
  );
}
if (!fs.existsSync(distRoutingFlag)) {
  throw new Error(
    `passthrough.bench.ts needs the built artifact at ${distRoutingFlag}. ` +
      `Build it first: bash scripts/build.sh (from cli).`,
  );
}

/** Spawn a fresh node and return only after it exits — one full cold start. */
function coldNode(source: string): void {
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'ignore',
    cwd: cliRoot,
  });
}

const distUrl = pathToFileURL(distPassthrough).href;
const routingFlagUrl = pathToFileURL(distRoutingFlag).href;

describe('cold module graph (per CLI invocation, out-of-process)', () => {
  bench(
    'node baseline (no import)',
    () => {
      coldNode('void 0;');
    },
    { iterations: 20, time: 0 },
  );

  bench(
    'node + import dist/lib/hosts/routing-flag.js (the bootstrap gate)',
    () => {
      coldNode(`await import(${JSON.stringify(routingFlagUrl)});`);
    },
    { iterations: 20, time: 0 },
  );

  bench(
    'node + import dist/lib/hosts/passthrough.js (routed path only)',
    () => {
      coldNode(`await import(${JSON.stringify(distUrl)});`);
    },
    { iterations: 20, time: 0 },
  );
});

/**
 * Which of `passthrough.ts`'s static imports carry the graph. Each is imported
 * alone in a fresh process, so the numbers are per-subgraph (they overlap — the
 * subgraphs share deps — and do not sum to the whole-file number above).
 *
 * Every entry here is reached ONLY after a routing flag is found:
 *   - `smart-launch.js`  — used for `--device auto`
 *   - `dispatch.js`      — used for teams-start --watch / streamAgentsOnHost
 *   - `registry.js`      — used inside resolveTargetHost
 *   - `machine-id.js`    — leaf (post RUSH-2374 proposal 2; was sync/config.js)
 *   - `health-report.js` — used on the all-sentinel fan-out
 */
const HEAVY_IMPORTS: Array<[string, string]> = [
  ['lib/smart-launch.js', 'smart-launch.js'],
  ['lib/hosts/dispatch.js', 'hosts/dispatch.js'],
  ['lib/hosts/registry.js', 'hosts/registry.js'],
  ['lib/machine-id.js (leaf, was session/sync/config.js)', 'machine-id.js'],
  ['lib/session/sync/config.js (pre-fix path — for delta)', 'session/sync/config.js'],
  ['lib/devices/health-report.js', 'devices/health-report.js'],
  ['lib/startup/command-registry.js', 'startup/command-registry.js'],
];

describe('cold import per static dependency (out-of-process)', () => {
  for (const [label, rel] of HEAVY_IMPORTS) {
    const target = path.join(cliRoot, 'dist/lib', rel);
    bench(
      label,
      () => {
        coldNode(`await import(${JSON.stringify(pathToFileURL(target).href)});`);
      },
      { iterations: 20, time: 0 },
    );
  }
});

/**
 * Realistic no-flag invocations — the 100% case for a local `agents <cmd>`.
 * Each returns `false` at `passthrough.ts:473` after four `flagValue` scans.
 * Bootstrap no longer calls into here without a flag; the body cost remains
 * the baseline for the rare mis-gated path and for direct unit use.
 */
const NO_FLAG_ARGVS: Array<[string, string[]]> = [
  ['view', ['view']],
  ['sync claude --yes', ['sync', 'claude', '--yes']],
  ['skills list', ['skills', 'list']],
  ['doctor', ['doctor']],
  [
    'run claude (long argv)',
    ['run', 'claude', '--mode', 'edit', '--name', 'bench', '--profile', 'default', '-p', 'do the thing', '--json'],
  ],
];

describe('hasHostRoutingFlag — bootstrap gate (warm, leaf)', () => {
  for (const [label, argv] of NO_FLAG_ARGVS) {
    bench(`agents ${label}`, () => {
      hasHostRoutingFlag(argv);
    });
  }
});

describe('maybeRunOnHost — no routing flag (warm graph)', () => {
  for (const [label, argv] of NO_FLAG_ARGVS) {
    bench(`agents ${label}`, async () => {
      await maybeRunOnHost(argv[0], argv);
    });
  }
});

describe('maybeRunOnHost — routing flag present, side-effect-free returns', () => {
  // OWN_HOST_COMMANDS member -> returns false at passthrough.ts early exit.
  bench('agents sessions --device box (own-host early return)', async () => {
    await maybeRunOnHost('sessions', ['sessions', '--device', 'box']);
  });

  // Not a known top-level command -> returns false at unknown-command gate.
  bench('agents sessoins --device box (unknown-command return)', async () => {
    await maybeRunOnHost('sessoins', ['sessoins', '--device', 'box']);
  });
});

describe('flagValue — the three argv scans maybeRunOnHost always runs when loaded', () => {
  const short = ['view'];
  const long = NO_FLAG_ARGVS[4][1];

  bench('flagValue x3 over ["view"]', () => {
    flagValue(short, 'device', 'D');
    flagValue(short, 'hosts');
    flagValue(short, 'devices');
  });

  bench('flagValue x3 over an 11-token argv', () => {
    flagValue(long, 'device', 'D');
    flagValue(long, 'hosts');
    flagValue(long, 'devices');
  });
});
