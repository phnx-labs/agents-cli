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
