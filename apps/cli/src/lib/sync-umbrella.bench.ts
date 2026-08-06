/**
 * Benchmark for the `agents sync` config-translation hot path: the reconcile
 * stage that turns the DotAgents repos into each agent's native on-disk format.
 *
 * The entry point is sync-umbrella.ts:96 `runUmbrellaSync`, but that function is
 * a sequencer, not the cost. Its planner is pure (sync-umbrella.ts:51
 * `planUmbrellaStages`, "Pure -- no I/O"), its repos stage is a `git pull`
 * (sync-umbrella.ts:109 `pullRepo`) and its secrets stage is network + scrypt.
 * Every local CPU/IO cost of a bare `agents sync` lives behind one line --
 * sync-umbrella.ts:152 `await refresh({ skipPrompts: yes, quiet })` -- so that is
 * what this file measures, decomposed into the four stages refresh.ts actually
 * runs per agent version:
 *
 *   1. DISCOVERY   refresh.ts:201 `getAvailableResources()` -> versions.ts:224,
 *                  re-called a second time per version inside the sync itself
 *                  (versions.ts:2799). Name-set scan across every layer.
 *   2. GUARD       versions.ts:2874-2875 `loadManifest` + `isStale` -- the fast
 *                  guard that returns early (versions.ts:2878) when nothing
 *                  drifted. The steady-state cost of `agents sync` on an
 *                  already-current machine.
 *   3. TRANSLATE   versions.ts:2777 `syncResourcesToVersion` -- the actual
 *                  translation into agent-native format (writers for commands,
 *                  skills, hooks, rules, permissions, mcp, subagents, plugins,
 *                  workflows).
 *   4. MANIFEST    versions.ts:3262 `buildSyncManifest` -> staleness/index.ts:89
 *                  `buildManifest`, written after EVERY full sync. Unlike the
 *                  guard it sha256s every byte of every source
 *                  (fingerprint.ts:24 `fingerprintFile`, fingerprint.ts:59
 *                  `fingerprintDir`).
 *
 * plus the hook lifecycle registration refresh.ts:275/289 runs per version
 * (`parseHookManifest` hooks.ts:1369, `registerHooksToSettings` hooks.ts:1611).
 *
 * NO MOCKING. Every bench runs against this machine's REAL ~/.agents layout --
 * the real user repo (`getUserAgentsDir()`), the real system repo, the real
 * extra repos (`getEnabledExtraRepos()`), and a REAL installed version home
 * under ~/.agents/.history/versions/claude/<version>/home discovered at runtime
 * via versions.ts:1284 `listInstalledVersions`. `process.cwd()` during a real
 * `vitest bench` run is apps/cli inside the invoking checkout, so the
 * project-layer walk (`getProjectAgentsDir`) runs at its real depth.
 *
 * Side effects, stated plainly -- these are real writes, identical to what
 * `agents sync claude@<version>` does today, not test scaffolding:
 *   - the write benches copy resources into the chosen version home and rewrite
 *     its `.sync-manifest.json` (versions.ts:3264 `saveManifest`);
 *   - the first full sync of a version whose selectors are unset writes default
 *     resource patterns into ~/.agents/agents.yaml (versions.ts:2806 ->
 *     state.ts:1266 `ensureVersionResourcePatterns`, which no-ops once set);
 *   - `registerHooksToSettings` rewrites that version home's settings.json.
 * The target version is deliberately the OLDEST installed claude, never the
 * newest, so a bench run never writes into the version home most likely to be
 * running the session that invoked it.
 *
 * This file is NOT part of `vitest run`: vitest.config.ts:9 includes only
 * `*.test.ts`, so it is reached exclusively by `vitest bench`.
 */
import { describe, bench } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { planUmbrellaStages } from './sync-umbrella.js';
import {
  getAvailableResources,
  getActuallySyncedResources,
  getNewResources,
  getProjectOnlyResources,
  getVersionHomePath,
  listInstalledVersions,
  syncResourcesToVersion,
} from './versions.js';
import { listResources } from './resources.js';
import { buildManifest, isStale, loadManifest, saveManifest } from './staleness/index.js';
import { getDetector } from './staleness/registry.js';
import { clearLayerCache } from './staleness/layers.js';
import { parseHookManifest, registerHooksToSettings } from './hooks.js';

const cwd = process.cwd();

/**
 * Real installed claude versions, oldest first (versions.ts:1315 sorts with
 * `compareVersions`). Write benches target the oldest; read-only benches prefer
 * a version that already carries a `.sync-manifest.json` so the guard path is
 * measured against a manifest this bench did not just author.
 */
const installedClaude = listInstalledVersions('claude');
const writeTarget = installedClaude[0];
const manifestTarget =
  installedClaude.find((v) => fs.existsSync(path.join(getVersionHomePath('claude', v), '.sync-manifest.json'))) ??
  writeTarget;

const hookManifest = parseHookManifest();

/**
 * Guard-path input. `loadManifest` (staleness/index.ts:66) returns null when the
 * file is absent or its `v` does not match MANIFEST_VERSION, in which case
 * versions.ts:2875 never reaches `isStale` -- so a null here means the guard
 * benches have nothing real to measure and skip rather than fabricate one.
 */
const storedManifest = manifestTarget ? loadManifest('claude', manifestTarget) : null;

describe('stage 0 -- planUmbrellaStages (sync-umbrella.ts:51): the only work the umbrella itself does', () => {
  bench('bare `agents sync` (fetchRepos + reconcile)', () => {
    planUmbrellaStages({});
  });

  bench('`agents sync --local` (reconcile only, the flag that skips straight to refresh)', () => {
    planUmbrellaStages({ local: true });
  });
});

describe.skipIf(!writeTarget)('stage 1 -- discovery: the name-set scan run once per refresh AND once per version', () => {
  bench('getAvailableResources(cwd) (versions.ts:224) -- refresh.ts:201 and again at versions.ts:2799', () => {
    getAvailableResources(cwd);
  });

  bench('listResources("skills") (resources.ts:184) -- called by resourceSourceMap, versions.ts:2674', () => {
    listResources('skills', cwd);
  });

  bench('listResources("commands") (resources.ts:184)', () => {
    listResources('commands', cwd);
  });

  bench('listResources("hooks") (resources.ts:184, the group-expanding branch at resources.ts:208)', () => {
    listResources('hooks', cwd);
  });

  bench('listResources("subagents") (resources.ts:184)', () => {
    listResources('subagents', cwd);
  });

  bench('the four listResources calls resourceSourceMap makes per pattern-derived sync (versions.ts:2838)', () => {
    for (const kind of ['commands', 'skills', 'hooks', 'subagents'] as const) {
      new Map(listResources(kind, cwd).map((r) => [r.name, r.source]));
    }
  });
});

describe.skipIf(!writeTarget)('stage 1b -- refresh.ts:211-212 new-resource diff (runs per agent even on the interactive path)', () => {
  const available = getAvailableResources(cwd);

  bench('getActuallySyncedResources + getNewResources (refresh.ts:211-212)', () => {
    const synced = getActuallySyncedResources('claude', writeTarget!);
    getNewResources(available, synced, getProjectOnlyResources());
  });
});

/**
 * `getActuallySyncedResources` is a fan-out over nine detectors
 * (versions.ts:460-468 `getDetector(kind, agent).list(ctx)`), so measuring it
 * whole says only that it is slow. This attributes the cost to a single kind,
 * which is what a proposal has to name.
 */
describe.skipIf(!writeTarget)('stage 1c -- per-detector breakdown of getActuallySyncedResources (versions.ts:460-468)', () => {
  const ctx = { version: writeTarget!, versionHome: getVersionHomePath('claude', writeTarget!), cwd };
  const kinds = ['commands', 'skills', 'hooks', 'rules', 'mcp', 'permissions', 'subagents', 'plugins', 'workflows'] as const;

  for (const kind of kinds) {
    bench(`detector "${kind}" (staleness/detectors/${kind}.ts) .list()`, () => {
      getDetector(kind, 'claude')?.list(ctx);
    }, kind === 'skills' || kind === 'plugins' ? { time: 3000, iterations: 5 } : {});
  }
});

describe.skipIf(!storedManifest)('stage 2 -- staleness guard (versions.ts:2874-2875): steady-state `agents sync` on a current box', () => {
  bench('isStale (staleness/index.ts:122), warm layer cache -- 2nd..Nth version in one refresh', () => {
    isStale(storedManifest!, 'claude', manifestTarget!, cwd);
  });

  bench(
    'isStale, COLD layer cache (layers.ts:53 clearLayerCache) -- the first version in a fresh `agents sync` process',
    () => {
      isStale(storedManifest!, 'claude', manifestTarget!, cwd);
    },
    {
      setup: (_t: unknown, mode: 'warmup' | 'run') => {
        if (mode === 'run') clearLayerCache();
      },
      iterations: 1,
      time: 1,
      warmupIterations: 0,
      warmupTime: 0,
    },
  );

  bench('loadManifest (staleness/index.ts:66) -- the JSON read in front of every guard', () => {
    loadManifest('claude', manifestTarget!);
  });
});

describe.skipIf(!writeTarget)('stage 4 -- buildManifest (staleness/index.ts:89): sha256 of every source, written after EVERY full sync', () => {
  bench('buildManifest (versions.ts:3262 buildSyncManifest) -- fingerprintFile/fingerprintDir over all layers', () => {
    buildManifest('claude', writeTarget!, cwd);
  });
});

describe.skipIf(!writeTarget)('stage 3 -- syncResourcesToVersion (versions.ts:2777): the real translation into agent-native format', () => {
  bench(
    'full sync, force:true (refresh.ts:247 forceFullSync) -- writers + orphan sweeps + buildManifest, every time',
    () => {
      syncResourcesToVersion('claude', writeTarget!, undefined, { force: true, cwd });
    },
    { time: 3000, iterations: 5 },
  );

  bench(
    'guard-hit sync (no force, no selection) -- the versions.ts:2878 early return when nothing drifted',
    () => {
      syncResourcesToVersion('claude', writeTarget!, undefined, { cwd });
    },
    { time: 2000 },
  );
});

describe.skipIf(!writeTarget || Object.keys(hookManifest).length === 0)(
  'stage 5 -- hook lifecycle registration (refresh.ts:275/289), run once per installed version',
  () => {
    bench('parseHookManifest (hooks.ts:1369) -- refresh.ts:275, once per refresh', () => {
      parseHookManifest({ warn: false });
    });

    bench('registerHooksToSettings (hooks.ts:1611) -- refresh.ts:289, once PER VERSION', () => {
      registerHooksToSettings('claude', getVersionHomePath('claude', writeTarget!), hookManifest);
    });
  },
);

/**
 * refresh.ts:207-209: an unattended `agents sync --yes` syncs
 * `listInstalledVersions(agentId)` -- every installed version, not just the
 * default -- and refresh.ts:283-285 registers hooks over the same set. So the
 * per-version costs above are multiplied by the install count. This measures
 * that multiplication directly on the real fan-out for one agent, using the
 * guard path (the realistic steady state) rather than forcing N full writes.
 */
describe.skipIf(installedClaude.length < 2)(
  `stage 6 -- per-version fan-out (refresh.ts:207-209): ${installedClaude.length} installed claude versions`,
  () => {
    bench('syncResourcesToVersion across EVERY installed claude version (guard path)', () => {
      for (const v of installedClaude) {
        syncResourcesToVersion('claude', v, undefined, { cwd });
      }
    }, { time: 3000 });
  },
);

// Keep the guard target's manifest exactly as found: the write benches above
// rewrite `.sync-manifest.json` for `writeTarget`, and when writeTarget ===
// manifestTarget that would leave the box with a manifest authored by a
// benchmark rather than by a real sync. Restoring is a correctness step, not
// cleanup -- a stale/foreign manifest changes what the NEXT real `agents sync`
// decides to do (versions.ts:2873-2879).
if (storedManifest && manifestTarget) {
  process.on('exit', () => {
    try { saveManifest('claude', manifestTarget, storedManifest); } catch { /* best effort */ }
  });
}
