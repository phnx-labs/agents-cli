/**
 * Filesystem paths for the tmux integration.
 *
 * Layout under ~/.agents/.cache/helpers/tmux/:
 *   server.sock        — shared tmux server socket hosting all named sessions
 *   <name>.json        — per-session provenance (cmd, cwd, created_at, source)
 *
 * A single shared server is simpler than per-session sockets: one round-trip
 * for `tmux ls`, one place to clean up, and no extra tmux servers eating
 * memory. Per-session isolation can still be opted into via `--socket`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTmuxDir } from '../state.js';

/** Default shared server socket — every `agents tmux *` command targets this unless overridden. */
export function getDefaultSocketPath(): string {
  return path.join(getTmuxDir(), 'server.sock');
}

/** Per-session provenance JSON. tmux itself is the source of truth for liveness; this file is metadata only. */
export function getSessionMetaPath(name: string): string {
  return path.join(getTmuxDir(), `${name}.json`);
}

/** Ensure the tmux scratch dir exists with restrictive permissions (sockets are user-private). */
export function ensureTmuxDir(): string {
  const dir = getTmuxDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}
