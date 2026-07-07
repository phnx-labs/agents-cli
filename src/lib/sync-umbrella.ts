/**
 * Umbrella `agents sync` orchestration — "make this machine current".
 *
 * Bare `agents sync` fetches the config repos then reconciles them into every
 * installed agent's version home. Secrets and sessions are opt-in stages
 * (`--secrets` / `--sessions`) — see `planUmbrellaStages` for why they're off by
 * default. Each stage is an existing exported library function; this module only
 * sequences them and decides — from the flags — which stages run. The planner is
 * pure so the flag matrix is unit-tested without any I/O.
 *
 * Stage backends:
 *   repos    -> git pull of ~/.agents + enabled ~/.agents-* extras (pullRepo)
 *   secrets  -> listRemoteBundles + pullBundle (needs a passphrase; skipped
 *               cleanly when none is available — tokenized non-interactive auth
 *               arrives with `agents login`, #366/#367)
 *   sessions -> syncSessions(), gated by isSyncConfigured() exactly like the daemon
 *   reconcile-> refresh({ skipPrompts }) — re-materialize resources into homes
 */

import { pullRepo } from './git.js';
import { getUserAgentsDir, getEnabledExtraRepos } from './state.js';
import { listRemoteBundles, pullBundle } from './secrets/sync.js';

/** The five umbrella flags off `agents sync`. */
export interface UmbrellaFlags {
  repos?: boolean;
  secrets?: boolean;
  sessions?: boolean;
  cloud?: boolean;
  local?: boolean;
}

/** Which stages a given flag combination runs. */
export interface UmbrellaPlan {
  fetchRepos: boolean;
  fetchSecrets: boolean;
  fetchSessions: boolean;
  reconcile: boolean;
}

/**
 * Decide which stages run. Pure — no I/O. Semantics:
 *   bare (no flags)        fetch repos, then reconcile
 *   --local                reconcile only, no fetch
 *   --cloud                fetch repos (or the selected subset), skip reconcile
 *   --repos/--secrets/...  fetch only the selected types, then reconcile
 * `--local` wins over everything; `--cloud` suppresses reconcile.
 *
 * Secrets and sessions are NOT part of the bare default — they are opt-in via
 * `--secrets` / `--sessions`. Pulling every secret bundle onto the machine on a
 * bare `agents sync` is more blast radius than the verb should carry by
 * default, and session transcripts are queryable on demand (`agents sessions
 * --host <machine>`) so they don't need eager mirroring.
 */
export function planUmbrellaStages(f: UmbrellaFlags): UmbrellaPlan {
  if (f.local) {
    return { fetchRepos: false, fetchSecrets: false, fetchSessions: false, reconcile: true };
  }
  const anySelector = !!(f.repos || f.secrets || f.sessions);
  if (anySelector) {
    return {
      fetchRepos: !!f.repos,
      fetchSecrets: !!f.secrets,
      fetchSessions: !!f.sessions,
      reconcile: !f.cloud,
    };
  }
  // No per-type selector: bare = repos + reconcile; --cloud = repos, no
  // reconcile. Secrets/sessions stay off unless explicitly selected above.
  return { fetchRepos: true, fetchSecrets: false, fetchSessions: false, reconcile: !f.cloud };
}

export interface UmbrellaResult {
  plan: UmbrellaPlan;
  repos?: { pulled: number; errors: string[] };
  secrets?: { pulled: number; skipped: boolean; reason?: string; errors: string[] };
  sessions?: { ran: boolean; pushed: number; pulled: number; merged: number };
  devices?: { synced: number; pending: number; skipped: boolean };
  reconciled: boolean;
}

export interface RunUmbrellaArgs {
  flags: UmbrellaFlags;
  /** Progress sink (already quiet-aware in the caller). */
  log: (msg: string) => void;
  /** Pass `skipPrompts` through to reconcile / non-interactive behavior. */
  yes: boolean;
  /** Secrets passphrase, if available (env var or prompt). Undefined => skip secrets. */
  passphrase?: string;
}

/**
 * Execute the planned stages in order: repos -> secrets -> sessions -> reconcile.
 * A failure in one fetch stage is recorded and does not abort the others or the
 * reconcile — `agents sync` should make as much current as it can in one pass.
 */
export async function runUmbrellaSync(args: RunUmbrellaArgs): Promise<UmbrellaResult> {
  const { flags, log, yes, passphrase } = args;
  const plan = planUmbrellaStages(flags);
  const result: UmbrellaResult = { plan, reconciled: false };

  if (plan.fetchRepos) {
    const dirs = [
      { alias: 'user', dir: getUserAgentsDir() },
      ...getEnabledExtraRepos().map((e) => ({ alias: e.alias, dir: e.dir })),
    ];
    let pulled = 0;
    const errors: string[] = [];
    for (const { alias, dir } of dirs) {
      const r = await pullRepo(dir);
      if (r.success) {
        pulled++;
        log(`repos: ${alias} → ${r.commit}`);
      } else {
        errors.push(`${alias}: ${r.error ?? 'unknown error'}`);
      }
    }
    result.repos = { pulled, errors };
  }

  if (plan.fetchSecrets) {
    if (!passphrase) {
      result.secrets = {
        pulled: 0,
        skipped: true,
        reason: 'no passphrase — set AGENTS_SECRETS_PASSPHRASE or run `agents login` (#366)',
        errors: [],
      };
      log('secrets: skipped (no passphrase available)');
    } else {
      let pulled = 0;
      const errors: string[] = [];
      try {
        const remote = await listRemoteBundles();
        for (const b of remote) {
          try {
            await pullBundle(b.name, { passphrase, force: true });
            pulled++;
            log(`secrets: ${b.name}`);
          } catch (err) {
            errors.push(`${b.name}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        errors.push((err as Error).message);
      }
      result.secrets = { pulled, skipped: false, errors };
    }
  }

  if (plan.fetchSessions) {
    // Gate exactly like the daemon: an off switch or a missing r2.backups bundle
    // is a clean no-op, not an error that fails the whole sync.
    const { isSyncConfigured, isSyncEnabled } = await import('./session/sync/config.js');
    if (isSyncEnabled() && isSyncConfigured()) {
      const { syncSessions } = await import('./session/sync/sync.js');
      const r = await syncSessions();
      result.sessions = { ran: true, pushed: r.pushed, pulled: r.pulled, merged: r.merged };
      log(`sessions: pushed ${r.pushed}, pulled ${r.pulled}, merged ${r.merged}`);
    } else {
      result.sessions = { ran: false, pushed: 0, pulled: 0, merged: 0 };
    }
  }

  if (plan.reconcile) {
    const { refresh } = await import('./refresh.js');
    await refresh({ skipPrompts: yes });
    result.reconciled = true;

    // Keep already-registered devices' reachability current, and surface newly
    // appeared tailnet nodes as "pending" for the menu-bar Register/Ignore gate
    // rather than silently adding them (refresh mode). Soft: a machine without
    // tailscale is a clean no-op, never a sync failure. First-run population is
    // `agents setup` / manual `agents devices sync` (bootstrap).
    const { runDeviceSync } = await import('./devices/sync.js');
    const { reconcilePendingSentinels } = await import('./devices/pending.js');
    const dev = await runDeviceSync({ soft: true, mode: 'refresh' });
    if (dev.ok) reconcilePendingSentinels(dev.pending);
    result.devices = { synced: dev.synced, pending: dev.pending.length, skipped: !dev.ok };
    if (dev.ok) {
      log(`devices: ${dev.synced} refreshed${dev.pending.length ? `, ${dev.pending.length} new pending` : ''}`);
    }
  }

  return result;
}
