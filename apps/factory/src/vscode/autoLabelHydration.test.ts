import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * RUSH-2411: a picked-host Codex launches idless, so its auto-label lifecycle was
 * never armed — the tab kept the bare `CX` chip after its canonical UUID resolved
 * via remote hydration. The behavioral logic is unit-tested in
 * `src/core/remoteAutoLabel.test.ts`; this file pins the extension-host WIRING
 * that connects that logic to the real terminal registry, the same way
 * `forkCommands.test.ts` pins the fork command wiring. Break any of these and the
 * fix silently reverts to bare-CX.
 */
const factoryRoot = path.resolve(import.meta.dir, '../..');
const extensionSource = fs.readFileSync(path.join(factoryRoot, 'src/vscode/extension.ts'), 'utf8');

describe('RUSH-2411 auto-label-after-remote-hydration wiring', () => {
  test('the canonical id transition arms the auto-label lifecycle', () => {
    // Inside applyHydratedSessionId, gaining/correcting the id must arm labeling —
    // the remote counterpart to the local SessionStart watcher (onSessionChanged).
    expect(extensionSource).toContain('armLabelingAfterHydration(terminal, entry);');
    // And armLabelingAfterHydration re-uses the ONE poller entry point.
    expect(extensionSource).toMatch(
      /function armLabelingAfterHydration[\s\S]*?startAutoLabelPollerForTerminal\(terminal, extensionContext\)/,
    );
  });

  test('an idless picked-host runner arms a bounded fast poller at launch', () => {
    // openSingleAgent only mints Claude's id up front; a picked-host Codex is
    // idless, so it must still arm the poller (fast) to resolve its id + label
    // without a refocus.
    expect(extensionSource).toMatch(
      /else if \(targetHost && resumeKey\)[\s\S]*?startAutoLabelPollerForTerminal\(terminal, context, \{ fast: true \}\)/,
    );
  });

  test('the poller drives id-hydration then labeling via the tested core helper', () => {
    // The remote-idless branch of the poller resolves the id (and host siblings)
    // from the shared active map and labels — one tick, no per-tab SSH stream.
    expect(extensionSource).toMatch(
      /needsSessionIdHydrate\(cur\.sessionId\)[\s\S]*?hydrateRemoteTabTick\(cur\.id, cur\.host, remoteAutoLabelHooks\(\)\)/,
    );
  });

  test('the focus-path join stamps + arms this tab and every host sibling', () => {
    // tryHydrateLiveSessionId's active-map join builds a plan over all host tabs
    // and applies it through applyHydratedSessionId (which arms labeling), so a
    // hydrated sibling enters labeling too.
    expect(extensionSource).toContain('planActiveMapHydration(');
    expect(extensionSource).toMatch(
      /for \(const step of plan\)[\s\S]*?applyHydratedSessionId\(t\.terminal, t, stampPrefix, step\.canonicalId\)/,
    );
  });

  test('the shared per-host active-map fetch is the id source (no per-tab SSH poll)', () => {
    // remoteAutoLabelHooks.fetchMap funnels through the coalesced per-host cache,
    // and the host-aware `agents sessions <id> --host` stays the LABEL source.
    expect(extensionSource).toMatch(/fetchMap:\s*\(host\)\s*=>\s*fetchTerminalIdSessionMap\(host\)/);
    expect(extensionSource).toMatch(/fetchLabel:[\s\S]*?fetchAndSetAutoLabel\(t\.terminal, t\)/);
  });
});
