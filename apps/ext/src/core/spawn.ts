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
  /**
   * Harness id (claude/codex/grok/…) when the caller already knows it.
   * Required for remote attach commands (`ssh … tmux attach`) where the local
   * process tree has no agent binary to sniff — without this the tab stays a
   * generic SH shell with the wrong icon (#2478).
   */
  agent?: string;
  /** Canonical session id to stamp on the terminal for resume/status-bar. */
  sessionId?: string;
  /** Optional pre-baked tab title; otherwise the extension formats from agent. */
  title?: string;
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
  const agent = typeof obj?.agent === 'string' && obj.agent.trim() ? obj.agent.trim().toLowerCase() : undefined;
  const sessionId =
    typeof obj?.sessionId === 'string' && obj.sessionId.trim() ? obj.sessionId.trim() : undefined;
  const title = typeof obj?.title === 'string' && obj.title.trim() ? obj.title.trim() : undefined;
  return { command, cwd, split, agent, sessionId, title };
}

// Which surface a spawn request lands on.
//   native-split — split the parent VS Code terminal
//   native-tab   — new editor tab backed by a plain VS Code terminal
export type SpawnSurface = 'native-split' | 'native-tab';

export interface SpawnSurfaceInput {
  // The request asked to split beside the previously spawned pane.
  wantsSplit: boolean;
  // A previously spawned pane is still alive to split from.
  hasParent: boolean;
}

// Pick the surface for a spawn request. Pure so the matrix is testable without
// the VS Code API; the glue in spawnCommandTerminal just executes the choice.
//
// AGI EXT no longer spawns tmux-backed terminals at the extension level, so a
// split always means a native VS Code terminal split.
export function resolveSpawnSurface(input: SpawnSurfaceInput): SpawnSurface {
  const splitting = input.wantsSplit && input.hasParent;
  return splitting ? 'native-split' : 'native-tab';
}
