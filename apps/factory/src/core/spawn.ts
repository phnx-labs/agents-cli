// Pure parsing for the `…/spawn?…` URI verb (no VS Code dependencies - testable).
// The VS Code glue that turns a SpawnRequest into an editor-tab terminal lives
// in vscode/extension.ts (spawnCommandTerminal).

export type SpawnSplit = 'right' | 'down';

export interface SpawnRequest {
  // Exact command line to run in the spawned terminal (e.g. "claude --resume <id>").
  command: string;
  // Working directory; falls back to the workspace root when absent.
  cwd?: string;
  // When set, split beside the previously spawned pane instead of a new tab.
  split?: SpawnSplit;
}

// Parse the query of a `…/spawn?p=<payload>` URI into a spawn request. The
// payload is base64url-encoded JSON in a single `p` param: VS Code percent-decodes
// uri.query once before we see it, so a command/cwd containing `&` or `=` would be
// mis-split by a multi-param query. base64url ([A-Za-z0-9_-]) survives that decode
// untouched. Returns null when there is no command to run. `split` is honoured
// only for the two supported directions; any other value is dropped, not trusted.
export function parseSpawnRequest(query: string): SpawnRequest | null {
  const p = new URLSearchParams(query).get('p');
  if (!p) return null;
  let obj: any;
  try {
    obj = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const command = typeof obj?.command === 'string' ? obj.command.trim() : '';
  if (!command) return null;
  const cwd = typeof obj?.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : undefined;
  const split: SpawnSplit | undefined =
    obj?.split === 'right' || obj?.split === 'down' ? obj.split : undefined;
  return { command, cwd, split };
}

// Which surface a spawn request lands on.
//   tmux-split  — split the live tmux parent (stay in its session)
//   tmux-tab    — new editor tab backed by a detached tmux session
//   native-split/native-tab — plain VS Code terminal (tmux off or unavailable)
export type SpawnSurface = 'tmux-split' | 'tmux-tab' | 'native-split' | 'native-tab';

export interface SpawnSurfaceInput {
  // Whether tmux is available (tmux is always used when it is — see launchAgent).
  useTmux: boolean;
  // The request asked to split beside the previously spawned pane.
  wantsSplit: boolean;
  // A previously spawned pane is still alive to split from.
  hasParent: boolean;
  // That parent is itself a tmux-backed terminal.
  parentIsTmux: boolean;
}

// Pick the surface for a spawn request. Pure so the matrix is testable without
// the VS Code API; the glue in spawnCommandTerminal just executes the choice.
//
// A split only happens with a live parent. When tmux is on we split *inside* the
// parent's tmux session rather than splitting the VS Code tab, because a VS Code
// split would put the new pane outside that session — losing the durable tmux
// coords the reconnect pass needs. A tmux-mode spawn against a non-tmux parent
// falls back to its own tmux tab rather than degrading to a native terminal, so
// the session still survives a window crash.
export function resolveSpawnSurface(input: SpawnSurfaceInput): SpawnSurface {
  const splitting = input.wantsSplit && input.hasParent;
  if (input.useTmux) {
    return splitting && input.parentIsTmux ? 'tmux-split' : 'tmux-tab';
  }
  return splitting ? 'native-split' : 'native-tab';
}
