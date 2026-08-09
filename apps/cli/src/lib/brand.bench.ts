/**
 * Benchmark for the brand ("white-label") bootstrap that runs on EVERY `agents`
 * invocation, including the unbranded fast path. Two distinct costs are measured
 * and kept separate, because they have opposite shapes:
 *
 *   A) The RUNTIME compute at index.ts:1244 (`const brandDisabled =
 *      disabledCommandsForActiveBrand()`), plus the two sibling calls at
 *      index.ts:241 (`const BRAND = resolveBrandName()`) and index.ts:367
 *      (`disabledCommandsForActiveBrand()` inside the help re-brander). This is
 *      measured in-process below.
 *
 *   B) The eager MODULE-IMPORT cost of `import { resolveBrandName,
 *      disabledCommandsForActiveBrand } from './lib/brand.js'` at index.ts:514.
 *      After RUSH-2331 brand.ts no longer imports agents.js — reservedBrandNames
 *      reads the zero-dep AGENT_CLI_COMMANDS leaf (agent-cli-commands.ts) instead.
 *      brand.js's remaining static imports are state.js + the leaf list (types is
 *      type-only, erased). The agents.js/versions.js rows below stay as historical
 *      baselines so a regression that re-introduces the agents edge is visible.
 *      Measured with real cold `node -e "await import(...)"` subprocesses, since
 *      Node caches an ESM module for the life of a process, so an in-process
 *      second import cannot see cold cost (same method as index.bench.ts's
 *      startup-graph group on the sibling perf branches).
 *
 * Call path (each claim file:line-quoted):
 *   index.ts:1244  disabledCommandsForActiveBrand()      (brand.ts:102)
 *     -> getActiveBrandConfig()                          (brand.ts:84)
 *        -> activeBrandName()                            (brand.ts:41)
 *           -> resolveBrandName()  env AGENTS_BRAND read (brand.ts:34-38)
 *        -> [UNBRANDED] name === null -> return null BEFORE any readMeta
 *           (brand.ts:86: `if (!name) return null;`)
 *        -> [BRANDED]   getBrandConfig(name)             (brand.ts:75)
 *              -> listBrands()                           (brand.ts:70)
 *                 -> readMeta().brands                   (state.ts:1124)
 *
 * The UNBRANDED path (AGENTS_BRAND unset — every plain `agents`/`ag` call) never
 * reaches readMeta: activeBrandName() returns null at brand.ts:43 and
 * getActiveBrandConfig() short-circuits at brand.ts:86, so the whole compute is
 * one env read + one regex test (brand.ts:36) + `new Set(undefined ?? [])`
 * (brand.ts:104). The BRANDED path (AGENTS_BRAND set) instead reaches
 * readMeta() (state.ts:1124), which serves from a stamp-keyed cache on a warm
 * hit (state.ts:1130-1134, ~2 stat syscalls) and reads+parses both
 * ~/.agents/.system/agents.yaml and ~/.agents/agents.yaml on a cold miss
 * (state.ts:1176-1189, fs.readFileSync + yaml.parse of each). The branded bench
 * sets AGENTS_BRAND to a name absent from the real meta, so it exercises the
 * real readMeta lookup (state.ts:1124) and then finds no config (brand.ts:88) —
 * the readMeta hop is the branded add-on regardless of whether a brand is
 * actually configured, and this box has none (`grep brands: ~/.agents/agents.yaml`
 * is empty).
 *
 * No mocking. The runtime benches call the real exported functions; the branded
 * ones hit the real ~/.agents/{,.system}/agents.yaml on this machine. The cold
 * import benches spawn a real `node` that imports the REAL BUILT artifacts under
 * ../../dist/lib/ (produced by `bun run build`), never the TS source, so the
 * measured graph is exactly what an installed CLI loads.
 *
 * Lives at src/lib/brand.bench.ts (1:1 with brand.ts) so `typecheck:bench`
 * (package.json:58, globs `src/lib/*.bench.ts`) type-checks it, and so
 * `vitest bench` picks it up. It is NOT run by `vitest run` — vitest.config.ts
 * `include` matches only `*.test.ts`, so this file never runs in the PR test gate;
 * run it explicitly with `bun run bench` (`vitest bench --run`) inside apps/cli.
 */
import { describe, bench } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  resolveBrandName,
  activeBrandName,
  isBranded,
  disabledCommandsForActiveBrand,
} from './brand.js';
import { readMeta } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure the runtime UNBRANDED benches see a genuinely unset brand, whatever the
// invoking shell exported.
delete process.env.AGENTS_BRAND;

// A brand name that passes brand.ts's BRAND_NAME_PATTERN (brand.ts:27) but is
// absent from the real meta.brands on this box, so the branded path runs the
// real readMeta() lookup (state.ts:1124) and then returns null (brand.ts:88).
const BENCH_BRAND = 'benchbrand';
const setBranded = () => { process.env.AGENTS_BRAND = BENCH_BRAND; };
const clearBranded = () => { delete process.env.AGENTS_BRAND; };

describe('brand runtime compute — index.ts:241 / index.ts:367 / index.ts:1244 (unbranded fast path)', () => {
  bench('resolveBrandName() — env read + regex test, AGENTS_BRAND unset (brand.ts:34-38)', () => {
    resolveBrandName();
  });

  bench('activeBrandName() — unbranded, returns null (brand.ts:41-44)', () => {
    activeBrandName();
  });

  bench('isBranded() — unbranded (brand.ts:47-49)', () => {
    isBranded();
  });

  bench('disabledCommandsForActiveBrand() — THE index.ts:1244 call, unbranded: short-circuits before readMeta, `new Set([])` (brand.ts:102-105 -> brand.ts:86)', () => {
    disabledCommandsForActiveBrand();
  });
});

describe('brand runtime compute — branded invocation (AGENTS_BRAND set): the readMeta hop', () => {
  bench('resolveBrandName() — branded, regex-validated name returned (brand.ts:36)', () => {
    resolveBrandName();
  }, { setup: setBranded, teardown: clearBranded });

  bench('disabledCommandsForActiveBrand() — branded: activeBrandName -> getBrandConfig -> listBrands -> readMeta().brands (brand.ts:102 -> brand.ts:70 -> state.ts:1124), meta cache warm after first call', () => {
    disabledCommandsForActiveBrand();
  }, { setup: setBranded, teardown: clearBranded });

  bench('readMeta() alone — the branded add-on, warm stamp-keyed cache hit (state.ts:1130-1134, ~2 stat syscalls + spread)', () => {
    readMeta();
  });
});

// --- Cold module-import cost (real subprocess per sample) ---------------------
//
// Node caches an ESM module for a process's life, so cold cost can only come
// from a fresh process. Each sample spawns `node --input-type=module -e "await
// import(<dist url>)"` importing the REAL built artifacts. `dist(p)` resolves
// under ../../dist/lib relative to this file (src/lib -> apps/cli), the same
// place the installed CLI runs from.
const distUrl = (p: string): string =>
  pathToFileURL(path.resolve(__dirname, '../../dist/lib', p)).href;

function coldImport(specs: string[]): void {
  const src = specs.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src || ';'], {
    stdio: 'ignore',
  });
  if (r.status !== 0) {
    throw new Error(
      `cold import failed (status ${r.status}, signal ${r.signal}): ${String(r.stderr).slice(0, 400)}`,
    );
  }
}

// index.ts's own static local-module imports (the eager startup graph), by
// line: dev-build(16), sync-commands(36), self-update(86), command-registry(124),
// help(208), whats-new(209), platform(211), cli-entry(212), events(213),
// event-provenance(214), format(215), state(513), brand(514). types.js (210) is
// type-only and erased at compile, so it is not a runtime edge.
const EAGER_MINUS_BRAND = [
  'startup/dev-build.js',
  'secrets/sync-commands.js',
  'self-update.js',
  'startup/command-registry.js',
  'help.js',
  'whats-new.js',
  'platform/index.js',
  'cli-entry.js',
  'events.js',
  'event-provenance.js',
  'format.js',
  'state.js',
].map(distUrl);
const EAGER_WITH_BRAND = [...EAGER_MINUS_BRAND, distUrl('brand.js')];

const COLD = { time: 0, iterations: 20, warmupIterations: 3 } as const;

describe('cold module import — isolate what the brand.js edge costs (real node subprocess per sample)', () => {
  bench('baseline: empty `node -e` process (fork+exec+runtime, no user import)', () => {
    coldImport([]);
  }, COLD);

  bench('import dist/lib/brand.js — brand.js + its full transitive (state.js + agent-cli-commands.js; no agents.js after RUSH-2331) into a fresh process', () => {
    coldImport([distUrl('brand.js')]);
  }, COLD);

  bench('import dist/lib/state.js alone — already paid at index.ts:513 regardless of brand', () => {
    coldImport([distUrl('state.js')]);
  }, COLD);

  bench('import dist/lib/agents.js alone — REGRESSION BASELINE; brand no longer imports this after RUSH-2331', () => {
    coldImport([distUrl('agents.js')]);
  }, COLD);

  bench('import dist/lib/types.js alone — the third brand.js import (mostly type-only)', () => {
    coldImport([distUrl('types.js')]);
  }, COLD);
});

describe('cold module import — brand.js MARGINAL cost on top of the rest of the eager graph', () => {
  bench('EAGER_MINUS_BRAND: the 12 other index.ts eager local imports, no brand edge', () => {
    coldImport(EAGER_MINUS_BRAND);
  }, COLD);

  bench('EAGER_WITH_BRAND: same 12 + dist/lib/brand.js (index.ts:514) — delta vs above is brand.js\'s true marginal startup cost, net of any transitive sharing', () => {
    coldImport(EAGER_WITH_BRAND);
  }, COLD);
});
