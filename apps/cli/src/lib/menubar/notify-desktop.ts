/**
 * Branded desktop notifications for daemon-originated events (RUSH-2030).
 *
 * The one place the daemon (overdue routines, heal, routine start/finish/output)
 * emits a native desktop notification. On macOS it routes through the installed
 * `MenubarHelper.app` companion — a one-shot `MenubarHelper --notify` invocation —
 * so the notification is attributed to that bundle and carries the agents-cli /
 * Agentialized mark instead of the generic AppleScript icon. When the companion
 * app is not installed (menu bar disabled, a Linux package, a dev checkout), it
 * degrades to `osascript` so an overdue/heal notice is never silently lost — the
 * generic icon is the acceptable cost of preserving delivery, not a bug hidden by
 * a fallback. On Linux it uses `notify-send`; every other platform is a no-op.
 *
 * All delivery is best-effort and fully detached: a missing binary surfaces as an
 * async 'error' event (not a synchronous throw), so every spawn attaches an
 * 'error' listener — without it Node re-throws ENOENT as an uncaught exception and
 * takes the whole daemon down (the exact crash overdue.test.ts guards).
 */

import { spawn } from 'child_process';
import * as os from 'os';
import { resolveInstalledMenubarExecutable } from './install-menubar.js';

export interface DesktopNotification {
  /** Bold first line. */
  title: string;
  /** Notification body text. */
  body: string;
  /** Secondary line under the title (macOS only). */
  subtitle?: string;
  /**
   * Deep-link the companion app runs when the notification is clicked. Encoded
   * as `<verb>:<arg>` — `open:/abs/path` opens a file (a run report or log) in the
   * default app; `routines:list` opens the runs folder (~/.agents/.history/runs)
   * in Finder. Best-effort and
   * macOS-only (osascript / notify-send have no click target). See routine-notify.ts.
   */
  action?: string;
}

/** Argv for the MenubarHelper one-shot notify mode. Exported for tests. */
export function buildMenubarNotifyArgs(n: DesktopNotification): string[] {
  const args = ['--notify', '--title', n.title, '--body', n.body];
  if (n.subtitle) args.push('--subtitle', n.subtitle);
  if (n.action) args.push('--action', n.action);
  return args;
}

/** AppleScript for the osascript degradation path. Exported for tests. */
export function buildOsascriptNotifyArgs(n: DesktopNotification): string[] {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let script = `display notification "${esc(n.body)}" with title "${esc(n.title)}"`;
  if (n.subtitle) script += ` subtitle "${esc(n.subtitle)}"`;
  return ['-e', script];
}

/** Spawn one detached, best-effort notifier process; swallow async ENOENT. */
function spawnDetachedQuiet(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  // A missing binary (headless box with no osascript/notify-send, or a helper
  // that vanished) arrives as an async 'error' event. Without this listener Node
  // re-throws it as an uncaught exception and crashes the daemon — swallow it.
  child.on('error', () => {});
  child.unref();
}

/**
 * Fire a native desktop notification, branded via the MenubarHelper companion on
 * macOS. Best-effort — any failure is swallowed so a notification hiccup never
 * blocks or crashes the daemon.
 */
export function notifyDesktop(n: DesktopNotification): void {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const exec = resolveInstalledMenubarExecutable();
      if (exec) {
        // Branded path: the notification is attributed to MenubarHelper.app, so it
        // shows the agents-cli mark and its click action is handled by the running
        // helper's UNUserNotificationCenter delegate.
        spawnDetachedQuiet(exec, buildMenubarNotifyArgs(n));
        return;
      }
      // Companion app absent — degrade to osascript so delivery is preserved
      // (generic icon; no click action). See the module header.
      spawnDetachedQuiet('osascript', buildOsascriptNotifyArgs(n));
      return;
    }
    if (platform === 'linux') {
      spawnDetachedQuiet('notify-send', [n.title, n.body]);
    }
    // Other platforms: no native desktop notifier wired — no-op.
  } catch {
    // Notification is best-effort; nothing to do.
  }
}
