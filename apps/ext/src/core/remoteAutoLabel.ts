/**
 * Auto-label lifecycle for offloaded (`--host`) agent tabs whose session id is
 * coined on the remote box and therefore never arrives via the local
 * SessionStart watcher.
 *
 * A picked-host Codex launches idless: `openSingleAgent` mints an id up front
 * only for Claude, so a remote Codex tab starts as a bare `CX` prefix with no
 * session id. Its canonical id shows up "later" through the shared
 * AGENT_TERMINAL_ID -> `agents sessions --active --host <device>` join
 * (`sessionIdHydrate.ts`). The bug (RUSH-2411): stamping that id refreshed the
 * status bar but never armed the auto-label poller, so the tab kept the bare
 * `CX` chip instead of a topic-derived title — unlike a LOCAL tab, where the
 * SessionStart watcher (`onSessionChanged`) arms labeling the instant the id
 * resolves.
 *
 * This module is the pure decision logic for the remote path: resolve the id
 * from the shared active map (surviving the post-launch indexing race by being
 * retried by the caller's bounded poller), then run the same label path. It has
 * no `vscode` dependency so it is unit-tested directly; the extension supplies
 * the real stamp / arm / label hooks.
 */

/** Minimal view of an AGI EXT tab needed to resolve + label it. */
export interface RemoteAutoLabelTab {
  /** AGENT_TERMINAL_ID — the join key against the active map. */
  id: string;
  /** Device the agent runs on (`undefined`/empty = this machine). */
  host?: string;
  /** Current session id (may be missing or a dirty rollout stem). */
  sessionId?: string;
}

/** One planned hydration: a tab and the canonical id the active map resolved. */
export interface HydratePlanEntry {
  id: string;
  canonicalId: string;
}

export interface HydratePlanDeps {
  /** Whether a tab still needs a CLI join (missing id, or a dirty rollout stem). */
  needsHydrate: (sessionId: string | undefined) => boolean;
  /** Canonicalize a raw active-map id (strip a `rollout-…` stem). '' if unusable. */
  canonical: (raw: string) => string;
}

/**
 * Plan which tabs a single active-map fetch can hydrate.
 *
 * Tabs whose stored id differs from the authoritative AGENT_TERMINAL_ID mapping
 * are included even when the stale value is already a clean UUID. This repairs
 * a fresh Codex tab that provisionally adopted an older same-cwd rollout before
 * its own rollout was indexed. An empty / partial map plans nothing — the caller
 * retries on the next poll tick. All tabs sharing one host resolve from the one
 * map, so every sibling enters the plan from a single fetch (no per-tab SSH
 * stream).
 */
export function planActiveMapHydration(
  map: Map<string, string>,
  tabs: RemoteAutoLabelTab[],
  deps: HydratePlanDeps,
): HydratePlanEntry[] {
  const plan: HydratePlanEntry[] = [];
  for (const tab of tabs) {
    const raw = map.get(tab.id);
    if (!raw) continue;
    const canonicalId = deps.canonical(raw);
    if (!canonicalId) continue;
    const currentCanonicalId = tab.sessionId ? deps.canonical(tab.sessionId) : '';
    if (!deps.needsHydrate(tab.sessionId) && currentCanonicalId === canonicalId) continue;
    plan.push({ id: tab.id, canonicalId });
  }
  return plan;
}

export interface RemoteAutoLabelHooks {
  /** Shared per-host active-map fetch (coalesced + TTL'd upstream). */
  fetchMap: (host: string | undefined) => Promise<Map<string, string>>;
  needsHydrate: (sessionId: string | undefined) => boolean;
  /** Canonicalize a raw active-map id. Returns '' when unusable. */
  canonical: (raw: string) => string;
  /** Every tab currently tracked (siblings are filtered to the same host here). */
  siblings: () => RemoteAutoLabelTab[];
  /**
   * Stamp the canonical id on a tab and arm its auto-label lifecycle — the same
   * transition the local SessionStart watcher performs. Called for the polled
   * tab AND every host sibling the one fetch resolved.
   */
  onHydrated: (tabId: string, canonicalId: string) => void;
  /** The tab's session id after any stamping this tick (to decide if labelable). */
  currentSessionId: (tabId: string) => string | undefined;
  /** Fetch + set the host-aware auto-label for a now-identified tab. */
  fetchLabel: (tabId: string) => Promise<string | undefined>;
}

export interface RemoteAutoLabelTickResult {
  /** Tabs whose id was resolved + labeling armed this tick (polled tab + siblings). */
  hydratedIds: string[];
  /** The polled tab's auto-label, when it resolved this tick. */
  label: string | undefined;
}

/**
 * One poll tick for an idless / still-hydrating remote tab.
 *
 * 1. One shared active-map fetch for the host resolves the polled tab AND every
 *    host sibling that still needs an id — each is stamped + armed via
 *    `onHydrated`. While the session is not indexed yet the map is empty and
 *    nothing is stamped; the caller's bounded poller retries.
 * 2. Once the polled tab has a real id, its host-aware label is fetched and set.
 *
 * No focus dependency: the whole `bare CX -> canonical UUID -> topic title`
 * transition happens from the poll tick alone.
 */
export async function hydrateRemoteTabTick(
  tabId: string,
  host: string | undefined,
  hooks: RemoteAutoLabelHooks,
): Promise<RemoteAutoLabelTickResult> {
  const map = await hooks.fetchMap(host);
  const hostKey = host ?? '';
  const hostTabs = hooks.siblings().filter((t) => (t.host ?? '') === hostKey);
  const plan = planActiveMapHydration(map, hostTabs, {
    needsHydrate: hooks.needsHydrate,
    canonical: hooks.canonical,
  });
  for (const step of plan) {
    hooks.onHydrated(step.id, step.canonicalId);
  }

  // The polled tab still has no usable id -> retry on the next tick.
  if (hooks.needsHydrate(hooks.currentSessionId(tabId))) {
    return { hydratedIds: plan.map((p) => p.id), label: undefined };
  }

  const label = await hooks.fetchLabel(tabId);
  return { hydratedIds: plan.map((p) => p.id), label };
}
