/**
 * The one place that decides WHERE a URL or file is shown to the human.
 *
 * Two browsers exist on a machine like this: the OS default handler, and the
 * profile `agents browser` drives. They are not interchangeable. The configured
 * profile is where the fleet's logins accumulate — `agents browser profiles
 * logins` lists them — so a page opened there is a page the user is already
 * signed in for, and a login acquired there is inherited by every later agent.
 * The OS handler has none of that.
 *
 * Before this seam existed, `agents browser navigate` honoured the configured
 * profile and nothing else did: `fleet login`, `devices lease`, `feedback`, and
 * the browser-session artifact opener each shelled straight to `open`/`xdg-open`,
 * so every one of them landed in whatever the OS handler happened to be. This
 * module replaces all of those call sites; do not add a sixth raw `open`.
 *
 * Never throws. A viewer that cannot be reached degrades to the OS handler with
 * one stderr line naming the reason, and a total failure returns `via: 'none'`
 * so the caller can print the URL rather than silently doing nothing.
 */
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';

/** Where a "show the human this" call actually landed. */
export type ShowOutcome =
  | { via: 'profile'; profile: string; tabId?: string }
  | { via: 'os'; command: string }
  | { via: 'none'; reason: string };

export interface ShowOptions {
  /**
   * Force the OS default handler, ignoring `browser.viewer`. This is the
   * The programmatic escape hatch, for a caller that must use the user's own
   * browser regardless of configuration. There is deliberately no CLI flag for
   * it: `agents config set browser.viewer os` is the user-facing control.
   */
  osBrowser?: boolean;
  /** Explicit profile override, ahead of `browser.viewer`. */
  profile?: string;
  /** Injected opener so the OS branch is testable without spawning anything. */
  spawnOpen?: (cmd: string, args: string[]) => boolean;
}

/**
 * Extensions a CDP tab renders at least as well as the OS default app.
 *
 * Deliberately narrow. `sessions-list.ts` EXT_KIND covers .png/.jpg/.webp/.pdf/
 * .webm, and for those Preview and QuickTime are the better viewer — routing a
 * screenshot into a browser tab is a downgrade, not a fix.
 */
const BROWSER_RENDERABLE = new Set(['.html', '.htm', '.svg', '.xhtml']);

function osOpen(target: string, spawnOpen?: (cmd: string, args: string[]) => boolean): ShowOutcome {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['open', [target]]]
      : process.platform === 'win32'
        ? // `start` treats a lone quoted first argument as the window TITLE, so the
          // empty title placeholder is required before the target. The three copies
          // of this that predated the seam disagreed on it ('' vs '""').
          [['cmd', ['/c', 'start', '', target]]]
        : [
            ['xdg-open', [target]],
            ['gnome-open', [target]],
          ];

  for (const [cmd, args] of candidates) {
    if (spawnOpen) {
      if (spawnOpen(cmd, args)) return { via: 'os', command: cmd };
      continue;
    }
    // spawnSync, NOT a detached spawn. `spawn` does not throw for a missing
    // binary — it emits an async `error` event — so a detached spawn cannot tell
    // success from "xdg-open is not installed", and every caller's failure branch
    // becomes unreachable. The two implementations this seam replaced both used
    // `spawnSync(...).status === 0` and genuinely detected failure; keeping that
    // is what makes `via: 'none'` reachable and the fallback to the next
    // candidate real. These openers hand off to the desktop and return in
    // milliseconds, so the block is not a stall.
    const { status, error } = spawnSync(cmd, args, { stdio: 'ignore' });
    if (!error && status === 0) return { via: 'os', command: cmd };
  }
  return { via: 'none', reason: 'no working OS opener on this platform' };
}

/**
 * Decide the viewer for this call. Exported for its own test — this is the one
 * place the policy lives.
 *
 * Every fall back to the OS handler prints one stderr line naming why. A silent
 * downgrade here is what made the original bug invisible for so long: the user
 * had configured a profile and had no way to see that it was being ignored.
 */
export async function resolveViewer(opts: ShowOptions = {}): Promise<'os' | { profile: string }> {
  if (opts.osBrowser) return 'os';

  const { getConfigValue } = await import('./device-config.js');
  const configured =
    opts.profile ?? ((getConfigValue('browser.viewer').value as string | undefined) || undefined);

  // Unset means "follow the profile agents drive" — the whole point is that a
  // machine with a configured browser stops leaking pages to the OS handler.
  const { getConfiguredDefaultProfileName, resolveProfileRef, getProfile, isProfileLaunchableHere } =
    await import('./browser/profiles.js');
  const name = configured ?? getConfiguredDefaultProfileName();

  if (!name) return 'os';
  if (name === 'os') return 'os';

  let resolved: string | undefined;
  try {
    resolved = await resolveProfileRef(name);
  } catch (err) {
    console.error(`[viewer] ${name}: ${err instanceof Error ? err.message : String(err)} — using the OS browser.`);
    return 'os';
  }

  if (!resolved) {
    console.error(`[viewer] "${name}" does not resolve to a profile — using the OS browser.`);
    return 'os';
  }
  const profile = await getProfile(resolved);
  if (!profile) {
    console.error(`[viewer] profile "${resolved}" is not configured — using the OS browser.`);
    return 'os';
  }
  if (profile.browser === 'arc') {
    // Arc exposes no CDP page targets and crashes on tab creation, so it can be
    // a configured profile but never a drivable viewer.
    console.error(`[viewer] "${resolved}" is Arc, which cannot be driven — using the OS browser.`);
    return 'os';
  }
  if (!isProfileLaunchableHere(profile)) {
    console.error(`[viewer] "${resolved}" cannot launch on this machine — using the OS browser.`);
    return 'os';
  }
  return { profile: resolved };
}

/** Show a URL to the human at this machine. Never throws. */
export async function showUrl(url: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  const viewer = await resolveViewer(opts);
  if (viewer === 'os') return osOpen(url, opts.spawnOpen);

  try {
    const { sendIPCRequest } = await import('./browser/ipc.js');
    // Deliberately does NOT auto-start the browser daemon. Showing a page is a
    // side errand — `devices lease` opens a console and immediately prompts for
    // a pasted key — so blocking that on a daemon cold start is a surprising
    // multi-second stall. Daemon already up: use the viewer. Not up: the OS
    // handler is the fast, correct answer.
    const response = await sendIPCRequest(
      { action: 'show', url, profile: viewer.profile },
      { autoStartDaemon: false },
    );
    if (response.ok) return { via: 'profile', profile: viewer.profile, tabId: response.tabId };
    console.error(`[viewer] ${viewer.profile}: ${response.error} — using the OS browser.`);
  } catch (err) {
    console.error(
      `[viewer] ${viewer.profile}: ${err instanceof Error ? err.message : String(err)} — using the OS browser.`,
    );
  }
  return osOpen(url, opts.spawnOpen);
}

/**
 * Show a local file. Browser-renderable kinds go through {@link showUrl}; every
 * other kind goes to the OS default APP, which for a screenshot or a recording
 * is the right viewer.
 */
export async function showFile(filePath: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  if (!BROWSER_RENDERABLE.has(path.extname(filePath).toLowerCase())) {
    return osOpen(filePath, opts.spawnOpen);
  }
  return showUrl(pathToFileURL(filePath).href, opts);
}

/**
 * Synchronous OS-default open. Returns true on success.
 *
 * Deliberately does NOT consult the viewer — it is the OS-handler primitive that
 * {@link osOpen} and the interactive artifact picker share.
 */
export function openArtifactSync(filePath: string): boolean {
  return osOpen(filePath).via === 'os';
}
