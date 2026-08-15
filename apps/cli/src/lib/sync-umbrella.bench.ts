/**
 * Benchmark for the `agents sync` config-translation hot path: the reconcile
 * stage that turns the DotAgents repos into each agent's native on-disk format.
 *
 * The entry point is sync-umbrella.ts:101 `runUmbrellaSync`, but that function is
 * a sequencer, not the cost. Its planner is pure (sync-umbrella.ts:51
 * `planUmbrellaStages`, "Pure -- no I/O"), its repos stage is a `git pull`
 * (sync-umbrella.ts:114 `pullRepo`) and its secrets stage is network + scrypt.
 * Every local CPU/IO cost of a bare `agents sync` lives behind one line --
 * sync-umbrella.ts:161 `await refresh({ skipPrompts: yes, quiet })` -- so that is
 * what this file measures, decomposed into the four stages refresh.ts actually
 * runs per agent version:
 *
 *   1. DISCOVERY   refresh.ts:200 `getAvailableResources()` -> versions.ts:224,
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
 * plus the hook lifecycle registration refresh.ts:287-294 runs per version
 * (`parseHookManifest` hooks.ts:1369 once per refresh at refresh.ts:275;
 * `registerHooksToSettings` hooks.ts:1611, called at refresh.ts:289).
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
 * `agents sync claude@<version>` does today, not test scaffolding. The list is
 * exhaustive; anything added here must be added to it:
 *   - EXACTLY ONE version home is written: `writeTarget`, the OLDEST installed
 *     claude, never the newest and never the `~/.claude`-symlinked default. The
 *     stage-3 full sync copies resources into it, orphan-sweeps stale entries
 *     (versions.ts:2945/2976/3013/3036/3067/3214) and rewrites its
 *     `.sync-manifest.json` (versions.ts:3264 `saveManifest`). Only the MANIFEST
 *     is restored on exit -- captured below as raw bytes, and deleted again if it
 *     did not exist before. The synced resources are left in place, exactly as a
 *     real `agents sync claude@<version>` would leave them.
 *   - Every OTHER installed version is touched only by stage 6, which is
 *     restricted to versions whose manifest is present and fresh, so
 *     `syncResourcesToVersion` provably takes the versions.ts:2878 early return
 *     and writes nothing into those homes. See `guardHitVersions`.
 *   - `<projectRoot>/.claude/` in the INVOKING CHECKOUT is rewritten on every
 *     `syncResourcesToVersion` call, guard hits included: versions.ts:2865-2867
 *     runs `syncProjectResourcesToAgent` BEFORE the guard, and
 *     project-resources.ts removes previously-managed paths and re-copies them
 *     into `<projectRoot>/.<agent>/`. A `.claude` glob is gitignored, so this
 *     cannot dirty a commit, but it is a real write and is named here rather
 *     than omitted.
 *   - The first sync of a version whose selectors are unset writes default
 *     resource patterns into ~/.agents/agents.yaml (versions.ts:2806 ->
 *     state.ts:1266 `ensureVersionResourcePatterns`, which no-ops once set).
 *   - `registerHooksToSettings` rewrites `writeTarget`'s settings.json and also
 *     writes OUTSIDE every version home, in two places. All of it is exactly
 *     what a real `agents sync` does, and none of it is inert:
 *       * the hook-shims dir: `sweepOrphanShims` (hooks.ts:1632) unlinks shims
 *         whose hook is gone (hooks.ts:1607); `generateHookShim` (hooks.ts:390
 *         -> hooks/cache.ts:149/152) rewrites a live shim whose content drifted
 *         and re-chmods 0o755 otherwise -- so a LIVE shim is written on every
 *         call, not only an orphaned one; and `removeHookShim` (hooks.ts:381 ->
 *         hooks/cache.ts:611) unlinks the live shim of a hook that declares no
 *         `cache:` / `matches:` / `matcher:`. UNDER `vitest bench` these land in
 *         a fork-private temp dir, NOT the real `~/.agents/.cache/shims/hooks`:
 *         tests/setup.ts:62 pins `AGENTS_HOOK_SHIMS_DIR` and state.ts:550 reads
 *         it at call time. So stage 5 pays first-write shim GENERATION rather
 *         than the warm re-chmod production takes -- read its number with that
 *         in mind. Outside vitest the same code writes the real global dir.
 *       * the hook SOURCE scripts in the DotAgents repos: `ensureExecutable`
 *         (hooks.ts:1644 -> hooks.ts:441) chmods `mode | 0o755` on any hook
 *         script that is not already executable. Hooks register by source path
 *         and are never copied, and there is NO env indirection here -- unlike
 *         the shims dir above, this one hits the user's real `hooks/` tree even
 *         under vitest.
 *
 * This file is NOT part of `vitest run`: vitest.config.ts:11 includes only
 * `*.test.ts` globs and there is no `benchmark.include`, so it is reached
 * exclusively by `vitest bench` (whose default include matches `*.bench.ts`).
 */
import { describe, bench } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { planUmbrellaStages } from './sync-umbrella.js';
import {
  getAvailableResources,
  getActuallySyncedResources,
  getGlobalDefault,
  getNewResources,
  getProjectOnlyResources,
  getVersionHomePath,
  listInstalledVersions,
  syncResourcesToVersion,
} from './versions.js';
import { listResources } from './resources.js';
import { buildManifest, isStale, loadManifest } from './staleness/index.js';
import { getDetector } from './staleness/registry.js';
import { clearLayerCache } from './staleness/layers.js';
import { parseHookManifest, registerHooksToSettings } from './hooks.js';

const cwd = process.cwd();

/**
 * Real installed claude versions, oldest first (versions.ts:1315 sorts with
 * `compareVersions`). The ONE version this bench is allowed to write into is
 * the oldest -- never the newest, never the `~/.claude`-symlinked default.
 */
const installedClaude = listInstalledVersions('claude');
const writeTarget = installedClaude[0];

/**
 * The version `refresh.ts:211` actually passes to `getActuallySyncedResources`
 * is `defaultVer` (refresh.ts:205 `getGlobalDefault(agentId)`), not the oldest.
 * The read-only detector benches use it so the number they report models the
 * real call. Falls back to `writeTarget` only when no global default is
 * recorded, in which case `refresh.ts:206` would `continue` past the agent
 * entirely and there is no "real" version to model.
 */
const detectorTarget = getGlobalDefault('claude') ?? writeTarget;

const hookManifest = parseHookManifest();

/**
 * Guard-path input. `loadManifest` (staleness/index.ts:66) returns null when the
 * file is absent or its `v` does not match MANIFEST_VERSION, in which case
 * versions.ts:2875 never reaches `isStale` -- so a null here means the guard
 * benches have nothing real to measure and skip rather than fabricate one.
 * Read-only: nothing in stage 2 writes, so this may safely be a version the
 * write benches never touch.
 */
const manifestTarget = detectorTarget;
const storedManifest = manifestTarget ? loadManifest('claude', manifestTarget) : null;

/**
 * Versions stage 6 may fan out over. `syncResourcesToVersion` only takes the
 * versions.ts:2878 early return when `loadManifest` returns a manifest AND
 * `isStale` is false (versions.ts:2873-2880); ANY other state falls through to
 * the full writer and ends at `saveManifest` (versions.ts:3264). Filtering here
 * -- with the same two read-only calls the guard itself makes -- is what makes
 * "stage 6 writes into no version home" true rather than merely intended. An
 * earlier revision looped every installed version and did rewrite all eight
 * manifests, including the default and the newest.
 */
const guardHitVersions = installedClaude.filter((v) => {
  const m = loadManifest('claude', v);
  return m !== null && !isStale(m, 'claude', v, cwd);
});

/**
 * Pre-run state of the ONE manifest the write benches rewrite. Captured as raw
 * bytes (not a parsed `SyncManifest`) so the restore is byte-exact, and as
 * `null` when the file does not exist yet -- in which case restoring means
 * DELETING the manifest the bench created, not writing some other version's.
 * Restoring is a correctness step, not cleanup: a foreign or invented manifest
 * changes what the next real `agents sync` decides to do (versions.ts:2873-2879).
 */
const writeTargetManifestPath = writeTarget
  ? path.join(getVersionHomePath('claude', writeTarget), '.sync-manifest.json')
  : null;
const writeTargetManifestBefore =
  writeTargetManifestPath && fs.existsSync(writeTargetManifestPath)
    ? fs.readFileSync(writeTargetManifestPath)
    : null;

describe('stage 0 -- planUmbrellaStages (sync-umbrella.ts:51): the only work the umbrella itself does', () => {
  bench('bare `agents sync` (fetchRepos + reconcile)', () => {
    planUmbrellaStages({});
  });

  bench('`agents sync --local` (reconcile only, the flag that skips straight to refresh)', () => {
    planUmbrellaStages({ local: true });
  });
});

describe.skipIf(!writeTarget)('stage 1 -- discovery: the name-set scan run once per refresh AND once per version', () => {
  bench('getAvailableResources(cwd) (versions.ts:224) -- refresh.ts:200 and again at versions.ts:2799', () => {
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

describe.skipIf(!detectorTarget)('stage 1b -- refresh.ts:211-212 new-resource diff (computed per agent on BOTH paths)', () => {
  const available = getAvailableResources(cwd);

  bench(`getActuallySyncedResources + getNewResources (refresh.ts:211-212), claude@${detectorTarget} (the refresh.ts:205 defaultVer)`, () => {
    const synced = getActuallySyncedResources('claude', detectorTarget!);
    getNewResources(available, synced, getProjectOnlyResources());
  });
});

/**
 * `getActuallySyncedResources` is a fan-out over nine detectors
 * (versions.ts:460-468 `getDetector(kind, agent).list(ctx)`), so measuring it
 * whole says only that it is slow. This attributes the cost to a single kind,
 * which is what a proposal has to name.
 */
describe.skipIf(!detectorTarget)('stage 1c -- per-detector breakdown of getActuallySyncedResources (versions.ts:460-468)', () => {
  const ctx = { version: detectorTarget!, versionHome: getVersionHomePath('claude', detectorTarget!), cwd };
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
 * default -- and refresh.ts:283-285 selects the same set for the hook
 * registration loop at refresh.ts:287-294. So the per-version costs above are
 * multiplied by the install count. This measures that multiplication on the
 * real fan-out.
 *
 * Restricted to `guardHitVersions` so it is provably a GUARD measurement and
 * writes into no version home -- see that binding for why the unrestricted loop
 * was not one. The label reports both counts so a box where the two differ
 * cannot silently read as full coverage.
 */
describe.skipIf(guardHitVersions.length < 2)(
  `stage 6 -- per-version fan-out (refresh.ts:207-209): ${guardHitVersions.length} of ${installedClaude.length} installed claude versions are guard hits`,
  () => {
    bench('syncResourcesToVersion across every guard-hit claude version', () => {
      for (const v of guardHitVersions) {
        syncResourcesToVersion('claude', v, undefined, { cwd });
      }
    }, { time: 3000 });
  },
);

// Put `writeTarget`'s manifest back exactly as found -- byte-for-byte if it
// existed, deleted if it did not. `saveManifest` (staleness/index.ts:77-87) and
// everything here is synchronous, which is what makes `process.on('exit')` a
// valid place to do it. A failure is printed, never swallowed: the restore is a
// correctness step (see `writeTargetManifestBefore`), so a silent miss would
// leave the box in a state the next real `agents sync` misreads.
if (writeTargetManifestPath) {
  process.on('exit', () => {
    try {
      if (writeTargetManifestBefore === null) fs.rmSync(writeTargetManifestPath, { force: true });
      else fs.writeFileSync(writeTargetManifestPath, writeTargetManifestBefore);
    } catch (err) {
      console.error(`sync-umbrella.bench: FAILED to restore ${writeTargetManifestPath}: ${(err as Error).message}`);
    }
  });
}
