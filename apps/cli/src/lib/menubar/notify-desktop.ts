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

import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { resolveInstalledMenubarExecutable } from './install-menubar.js';

/**
 * Hard ceiling on a one-shot notifier's lifetime. A notifier posts and exits in
 * well under a second on the happy path; if delivery stalls (locked screen, a
 * WindowServer/XPC hiccup) a detached GUI helper can hang indefinitely and pile
 * up in the menu bar. This is above the Swift one-shot's own 0.6s flush + its 3s
 * self-terminate watchdog, so Node's kill is the last-resort guarantee that runs
 * only if the child never self-exits.
 */
const NOTIFY_TIMEOUT_MS = 4000;

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

/**
 * Spawn one detached, best-effort notifier process with a bounded lifetime.
 *
 * The child is detached + unref'd so it never blocks the daemon, but — unlike a
 * pure fire-and-forget — it is supervised: a watchdog SIGKILLs it after
 * `timeoutMs` so a stalled notifier can never linger (the pile-up this fixes).
 * The common path (a sub-second post + self-exit) clears the watchdog on the
 * child's own 'exit', so the kill only ever fires for a genuinely hung child.
 *
 * `timeoutMs` is injectable so the bounded-lifetime behaviour is testable against
 * a real long-running child without a multi-second wait. Returns the child so a
 * caller/test can observe it; callers in this module ignore it.
 */
export function spawnDetachedQuiet(
  command: string,
  args: string[],
  timeoutMs: number = NOTIFY_TIMEOUT_MS,
): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  // Bound the lifetime: a stalled notifier is hard-killed after the timeout. The
  // timer is unref'd so it never keeps a short-lived caller's event loop alive.
  const watchdog = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  watchdog.unref();
  // A missing binary (headless box with no osascript/notify-send, or a helper
  // that vanished) arrives as an async 'error' event — the process never started,
  // so cancel the watchdog. Without a listener Node re-throws ENOENT as an
  // uncaught exception and crashes the daemon; having one swallows it.
  child.on('error', () => clearTimeout(watchdog));
  // Fast, self-driven exit (the common path) — cancel the watchdog.
  child.on('exit', () => clearTimeout(watchdog));
  child.unref();
  return child;
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
