// isLeader() gate — foundation 3/3 of the centralized-monitor epic (#64).
//
// `runOnLeaderOnly` is the single seam every heavy starter is wrapped in: the
// monitor host (here, today) and the migrated probes/watchers/watchdog/panel
// (#68-71, later). `start` runs once when this window GAINS leadership (or
// immediately if it already holds it); the Disposable it returns is disposed
// the moment leadership is LOST. Re-gaining leadership starts a fresh instance.
//
// Driven entirely by the leader elector (#65) — no vscode dependency — so it
// runs and tests in a plain process (see gate.test.ts).

import { Disposable, isLeader, onLeadershipChange } from './leader';

/**
 * Start `start()` only while this window is the elected monitor leader; dispose
 * it on leadership loss. The returned Disposable detaches the leadership
 * listener and tears down any running instance.
 */
export function runOnLeaderOnly(start: () => Disposable): Disposable {
  let current: Disposable | undefined;

  const apply = (leader: boolean): void => {
    if (leader && !current) {
      try {
        current = start();
      } catch (err) {
        console.error('[MONITOR] leader-only start threw:', err);
      }
    } else if (!leader && current) {
      try {
        current.dispose();
      } catch (err) {
        console.error('[MONITOR] leader-only dispose threw:', err);
      }
      current = undefined;
    }
  };

  // Cover the already-leader case: onLeadershipChange only fires on a FLIP, so a
  // window that won the election before this gate was wired would never start.
  apply(isLeader());
  const sub = onLeadershipChange(apply);

  return {
    dispose(): void {
      sub.dispose();
      if (current) {
        try {
          current.dispose();
        } catch (err) {
          console.error('[MONITOR] leader-only dispose threw:', err);
        }
        current = undefined;
      }
    },
  };
}
