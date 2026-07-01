/**
 * Launch a resumed session into a terminal tab.
 *
 * `agents sessions resume` multi-selects sessions and fans them out — one tab
 * per session — into the terminal the user picks: the one they're in now
 * (auto-detected via TERM_PROGRAM), a new iTerm tab, or a new Ghostty tab.
 *
 * The builders here are pure argv/AppleScript factories so they can be
 * unit-tested without a display; `launchResumeInTab` is the thin spawn wrapper.
 * They take a pre-built resume argv (from `buildResumeCommand`) rather than a
 * SessionMeta so this module stays free of any command-layer dependency.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';

/** A concrete place a resume can open. `inplace` takes over the current process. */
export type ResumeTarget = 'inplace' | 'iterm' | 'ghostty' | 'tmux';

/** A destination offered in the picker: a label plus the concrete target it resolves to. */
export interface DestinationChoice {
  id: 'this' | 'iterm' | 'ghostty';
  label: string;
  detail: string;
  target: ResumeTarget;
}

const ITERM_APP = '/Applications/iTerm.app';
const GHOSTTY_APP = '/Applications/Ghostty.app';

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** POSIX single-quote a string for safe embedding in a shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript double-quoted string literal (escape backslash, then quote). */
export function appleScriptStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Detect which terminal emulator the CLI is currently running in, mapped to a
 * concrete launch target. iTerm and Ghostty both set TERM_PROGRAM; tmux exposes
 * $TMUX. Anything we can't open a tab into resolves to `inplace`.
 */
export function detectCurrentTerminal(env: NodeJS.ProcessEnv = process.env): ResumeTarget {
  if (env.TMUX) return 'tmux';
  const term = (env.TERM_PROGRAM || '').toLowerCase();
  if (term.includes('iterm')) return 'iterm';
  if (term.includes('ghostty')) return 'ghostty';
  return 'inplace';
}

/**
 * The destinations offered in the chooser, given platform + which terminal
 * we're in + what's installed. Off macOS only "this terminal" is meaningful
 * (tmux window or in-place); the iTerm/Ghostty app targets are macOS-only and
 * appear only when the app is actually installed.
 */
export function availableDestinations(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): DestinationChoice[] {
  const current = detectCurrentTerminal(env);
  const currentLabel =
    current === 'iterm' ? 'iTerm' :
    current === 'ghostty' ? 'Ghostty' :
    current === 'tmux' ? 'tmux window' : 'in place';
  const out: DestinationChoice[] = [{
    id: 'this',
    label: 'This terminal',
    detail: `new tab in the terminal you're in now (${currentLabel})`,
    target: current,
  }];
  if (platform === 'darwin') {
    if (appExists(ITERM_APP)) {
      out.push({ id: 'iterm', label: 'iTerm', detail: 'one new iTerm tab per session', target: 'iterm' });
    }
    if (appExists(GHOSTTY_APP)) {
      out.push({ id: 'ghostty', label: 'Ghostty', detail: 'one new Ghostty tab per session', target: 'ghostty' });
    }
  }
  return out;
}

/**
 * Shell string that cd's into cwd and execs the resume argv.
 *
 * The wrappers below run this via `zsh -ilc` — an *interactive* login shell.
 * `-i` is load-bearing, not cosmetic: the version-pinned shims (`claude@2.1.187`)
 * live in `~/.agents/.cache/shims`, which `.zshrc` puts on PATH for interactive
 * shells only. A plain `zsh -lc` (login, non-interactive) skips `.zshrc`, so the
 * shim isn't found and the tab dies with "command not found". Do not drop `-i`.
 */
function loginExec(cwd: string, resume: string[]): string {
  return `cd ${shellQuote(cwd)} && exec ${resume.join(' ')}`;
}

/** AppleScript that opens an iTerm tab (a window if none is open) running the resume. */
export function itermTabScript(cwd: string, resume: string[]): string {
  const cmd = appleScriptStr(`zsh -ilc ${shellQuote(loginExec(cwd, resume))}`);
  return [
    'tell application "iTerm2"',
    '  activate',
    '  if (count of windows) is 0 then',
    `    create window with default profile command ${cmd}`,
    '  else',
    `    tell current window to create tab with default profile command ${cmd}`,
    '  end if',
    'end tell',
  ].join('\n');
}

/** AppleScript that opens a Ghostty tab (a window if none is open) running the resume. */
export function ghosttyTabScript(cwd: string, resume: string[]): string {
  // Ghostty (>=1.3) runs `command` directly; wrap it in an interactive login
  // shell so the version-pinned shim (e.g. claude@2.1.187) resolves on PATH.
  // cwd is a native surface property, so no `cd` is needed.
  const cmd = appleScriptStr(`zsh -ilc ${shellQuote(`exec ${resume.join(' ')}`)}`);
  return [
    'tell application "Ghostty"',
    '  activate',
    '  set cfg to new surface configuration',
    `  set initial working directory of cfg to ${appleScriptStr(cwd)}`,
    `  set command of cfg to ${cmd}`,
    '  if (count of windows) is 0 then',
    '    new window with configuration cfg',
    '  else',
    '    new tab in front window with configuration cfg',
    '  end if',
    'end tell',
  ].join('\n');
}

/**
 * Build the spawn argv that opens the resume in the given target.
 * `inplace` returns the resume argv itself (the caller spawns it with inherited
 * stdio so it takes over the current terminal).
 */
export function buildLaunchArgv(target: ResumeTarget, cwd: string, resume: string[]): string[] {
  switch (target) {
    case 'iterm':   return ['osascript', '-e', itermTabScript(cwd, resume)];
    case 'ghostty': return ['osascript', '-e', ghosttyTabScript(cwd, resume)];
    // Wrap in an interactive login shell for the same PATH reason as loginExec:
    // tmux runs new-window commands via a non-interactive shell otherwise.
    case 'tmux':    return ['tmux', 'new-window', '-c', cwd, `zsh -ilc ${shellQuote(`exec ${resume.join(' ')}`)}`];
    case 'inplace': return resume;
  }
}

export interface LaunchResult {
  ok: boolean;
  error?: string;
}

/**
 * Fire off a tab launch (any target except `inplace`). Resolves when the
 * launcher process (osascript / tmux) exits. Never rejects — a failed launch
 * comes back as `{ ok: false, error }` so a fan-out loop can keep going.
 */
export function launchResumeInTab(
  target: Exclude<ResumeTarget, 'inplace'>,
  cwd: string,
  resume: string[],
): Promise<LaunchResult> {
  const argv = buildLaunchArgv(target, cwd, resume);
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' });
    child.on('error', (err: any) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `${argv[0]} exited with code ${code}` }),
    );
  });
}
