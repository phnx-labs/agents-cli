// hook-manifest check — detects manifest hooks whose `script:` resolves to
// nothing, so they are registered in config but silently never installed.
//
// Why this exists. resolveHookScriptPath only resolves a manifest script under
// <root>/hooks/, and resolveContainedHookPath rejects any candidate escaping
// that root. A manifest entry pointing anywhere else returns null and the hook
// is dropped — no error, no warning, no trace in `agents doctor`.
//
// That is not hypothetical. main-branch-guard was declared in agents.yaml as
//   script: rules/subrules/truly-agentic-git-workflow/main-branch-guard.sh
// which resolves to hooks/rules/subrules/... — a path that does not exist. The
// guard was authored, tested with a 100+ case suite, and registered, yet
// reached zero of 25 settings files across three machines. Nothing surfaced it;
// it was found only after four agent sessions had written into a primary
// checkout that this exact hook exists to prevent.
//
// A guard that silently does not run is worse than a missing one, because the
// config says it is there. This check turns that silence into a finding.

import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { parseHookManifest, resolveHookScriptPath } from '../../hooks/install.js';

export const hookManifestCheck: HealCheck = {
  id: 'hook-manifest',
  title: 'Hook manifest scripts resolve',
  cadence: 'periodic',
  async run(_ctx: HealCtx): Promise<CheckResult> {
    const needsAttention: string[] = [];

    let manifest: Record<string, { script?: string; enabled?: boolean }>;
    try {
      // warn:false — this check reports, it does not double-log.
      manifest = parseHookManifest({ warn: false }) as typeof manifest;
    } catch (err) {
      return resultOf([], [`hook manifest unreadable: ${(err as Error).message}`]);
    }

    for (const [name, def] of Object.entries(manifest)) {
      if (!def || typeof def.script !== 'string' || def.script.length === 0) continue;
      if (def.enabled === false) continue;
      // An absolute script (a subrule-composed hook) is used as-is by the
      // installer, so only relative manifest paths go through the hooks/ root
      // resolver that can silently return null.
      if (def.script.startsWith('/')) continue;
      if (resolveHookScriptPath(def.script) === null) {
        needsAttention.push(
          `hook '${name}' declares script '${def.script}', which resolves to no file under any hooks/ root — ` +
            `it is registered but silently never installed. Move the script under hooks/ (or point the manifest at ` +
            `an entrypoint there) so the installer can find it.`
        );
      }
    }

    // Report only. Repair would mean guessing where the author meant the script
    // to live, and a wrong guess would wire the wrong file into a PreToolUse
    // gate. Naming the broken entry is the fix that belongs here.
    return resultOf([], needsAttention);
  },
};
