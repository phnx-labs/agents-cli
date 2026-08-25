/**
 * iTerm backend — drives iTerm2 via AppleScript (`osascript`).
 *
 * Tab: creates a tab in the current window (or a window when none is open).
 * Split: splits the current session — `split vertically` (side-by-side, a
 * vertical divider) for `right`, `split horizontally` (stacked) for `down`.
 */
import * as fs from 'fs';
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';
import { appleScriptStr } from '../quote.js';
import { loginExec, iLoginShell } from '../shell.js';

const ITERM_APP = '/Applications/iTerm.app';

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** AppleScript that opens an iTerm tab (a window if none is open) running the command. */
export function itermTabScript(cwd: string, command: string[]): string {
  const cmd = appleScriptStr(iLoginShell(loginExec(cwd, command)));
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

/** AppleScript that splits the current iTerm session (a window if none is open). */
export function itermSplitScript(cwd: string, command: string[], direction: SplitDirection): string {
  const cmd = appleScriptStr(iLoginShell(loginExec(cwd, command)));
  // iTerm: "split vertically" = a vertical divider = panes side by side (right).
  const verb = direction === 'right' ? 'split vertically' : 'split horizontally';
  return [
    'tell application "iTerm2"',
    '  activate',
    '  if (count of windows) is 0 then',
    `    create window with default profile command ${cmd}`,
    '  else',
    `    tell current session of current window to ${verb} with default profile command ${cmd}`,
    '  end if',
    'end tell',
  ].join('\n');
}

export const itermBackend: TerminalBackend = {
  id: 'iterm',
  label: 'iTerm',
  isAvailable(ctx: EngineContext): boolean {
    return ctx.platform === 'darwin' && appExists(ITERM_APP);
  },
  buildTab(cwd: string, command: string[]): LaunchSpec {
    return { argv: ['osascript', '-e', itermTabScript(cwd, command)] };
  },
  buildSplit(cwd: string, command: string[], direction: SplitDirection): LaunchSpec {
    return { argv: ['osascript', '-e', itermSplitScript(cwd, command, direction)] };
  },
};
