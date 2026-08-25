/**
 * tmux backend — opens windows and splits in the running tmux server.
 *
 * cwd is passed natively via `-c`, so the command is wrapped in `zsh -ilc` with
 * no `cd`. `split-window -h` = side-by-side (right); `-v` = stacked (down).
 * Available only when the CLI is running inside tmux (`$TMUX` set) — otherwise
 * there is no current window/pane to attach to.
 */
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';
import { execOnly, iLoginShell } from '../shell.js';

/** argv that opens a new tmux window running the command in cwd. */
export function tmuxTabArgv(cwd: string, command: string[]): string[] {
  return ['tmux', 'new-window', '-c', cwd, iLoginShell(execOnly(command))];
}

/** argv that splits the current tmux pane, running the command in cwd. */
export function tmuxSplitArgv(cwd: string, command: string[], direction: SplitDirection): string[] {
  const flag = direction === 'right' ? '-h' : '-v';
  return ['tmux', 'split-window', flag, '-c', cwd, iLoginShell(execOnly(command))];
}

export const tmuxBackend: TerminalBackend = {
  id: 'tmux',
  label: 'tmux',
  isAvailable(ctx: EngineContext): boolean {
    return Boolean(ctx.env.TMUX);
  },
  buildTab(cwd: string, command: string[]): LaunchSpec {
    return { argv: tmuxTabArgv(cwd, command) };
  },
  buildSplit(cwd: string, command: string[], direction: SplitDirection): LaunchSpec {
    return { argv: tmuxSplitArgv(cwd, command, direction) };
  },
};
