/**
 * Terminal.app backend — drives macOS Terminal via AppleScript (`osascript`).
 *
 * This is the floor of the backend list: every Mac has Terminal.app, so a GUI
 * caller that can name no better terminal still gets a surface. It is also what
 * the menu bar's "New Session" always used before the engine took that path
 * over, so registering it keeps a Terminal-only Mac working exactly as it did.
 *
 * Terminal.app has no scriptable split — `do script` only ever makes a tab (or a
 * window). A split request therefore opens a TAB, which is stated here and in
 * `buildSplit` rather than silently pretending the pane happened.
 */
import * as fs from 'fs';
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';
import { appleScriptStr } from '../quote.js';
import { loginExec, iLoginShell } from '../shell.js';

const TERMINAL_APP = '/System/Applications/Utilities/Terminal.app';
const TERMINAL_APP_LEGACY = '/Applications/Utilities/Terminal.app';

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * AppleScript that opens a Terminal.app tab running the command.
 *
 * `do script` with no `in` target opens a NEW window; with a front window
 * present, `tell application "System Events" to keystroke "t"` would be the only
 * way to force a tab, and that needs an Accessibility grant. So: a window when
 * none exists, otherwise `do script … in front window`, which Terminal renders
 * as a new tab of that window when its "New tabs" setting is on and a new
 * window otherwise. Either way the command runs in a fresh, visible surface.
 */
export function terminalAppTabScript(cwd: string, command: string[]): string {
  const cmd = appleScriptStr(iLoginShell(loginExec(cwd, command)));
  return [
    'tell application "Terminal"',
    '  activate',
    '  if (count of windows) is 0 then',
    `    do script ${cmd}`,
    '  else',
    `    do script ${cmd} in front window`,
    '  end if',
    'end tell',
  ].join('\n');
}

export const terminalAppBackend: TerminalBackend = {
  id: 'terminal',
  label: 'Terminal',
  /**
   * Terminal.app is scriptable only from a session that can reach the GUI login
   * — an `osascript` fired over plain SSH gets "Application isn't running" — so
   * an SSH-hosted context reports it unavailable rather than launching into a
   * window nobody can see. (A launchd GUI agent like the menu bar helper has no
   * SSH_* vars and is available.)
   */
  isAvailable(ctx: EngineContext): boolean {
    if (ctx.platform !== 'darwin') return false;
    if (ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY) return false;
    return appExists(TERMINAL_APP) || appExists(TERMINAL_APP_LEGACY);
  },
  buildTab(cwd: string, command: string[]): LaunchSpec {
    return { argv: ['osascript', '-e', terminalAppTabScript(cwd, command)] };
  },
  /** Terminal.app cannot split by script — a split request opens a tab instead. */
  buildSplit(cwd: string, command: string[], _direction: SplitDirection): LaunchSpec {
    return { argv: ['osascript', '-e', terminalAppTabScript(cwd, command)] };
  },
};
