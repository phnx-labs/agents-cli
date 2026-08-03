/**
 * Favorited (starred) sessions — the durable "keep this one handy" mark a human
 * puts on a session, deliberately kept OUT of the session index.
 *
 * `sessions.db` is a rebuildable CACHE: a reindex or a schema bump throws its
 * rows away and re-derives them from the transcripts on disk. A favorite is not
 * derivable from a transcript — it is a human's choice — so a column there would
 * be silently lost on the next rebuild. It lives in `~/.agents/.history/` instead,
 * next to the actor sidecars, which is never pruned.
 *
 * One flat set of session ids. The id is the transcript's own uuid, so it is
 * stable and machine-independent — but the file is NOT synced today: session sync
 * carries `.history/backups/` (`lib/session/sync/agents.ts`), not this. Favorites
 * are therefore per-machine; carrying them across the fleet would mean adding
 * them to the sync manifest, which this does not do.
 *
 * Reads are memoized against the file's mtime — the picker asks `isFavorite` once
 * per rendered row, and re-reading a JSON file per row on every keystroke is the
 * kind of cost that makes a TUI feel broken.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getHistoryDir } from '../state.js';

/** The on-disk shape. Versioned so a later format can migrate rather than guess. */
interface FavoritesFile {
  version: 1;
  sessionIds: string[];
}

export function favoritesFilePath(): string {
  return path.join(getHistoryDir(), 'favorites.json');
}

/** Memoized parse, invalidated by the file's mtime+size (another process — or
 *  another machine's sync — can rewrite it under us). */
let cache: { key: string; ids: Set<string> } | null = null;

function statKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

/** Drop the memoized read. Tests that write the file directly need this; nothing
 *  in the CLI does, because every mutation here refreshes the cache itself. */
export function clearFavoritesCache(): void {
  cache = null;
}

/**
 * Every favorited session id. Empty (never throws) when the file is absent,
 * unreadable, or malformed — a corrupt favorites file must not take down
 * `agents sessions`.
 */
export function listFavorites(): Set<string> {
  const file = favoritesFilePath();
  const key = statKey(file);
  if (cache && cache.key === key) return cache.ids;
  let ids = new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FavoritesFile>;
    if (Array.isArray(parsed?.sessionIds)) {
      ids = new Set(parsed.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0));
    }
  } catch {
    // absent / unreadable / malformed — an empty set is the honest answer
  }
  cache = { key, ids };
  return ids;
}

export function isFavorite(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return listFavorites().has(sessionId);
}

/** Atomic write (tmp + rename) so a concurrent reader never sees a half file. */
function writeFavorites(ids: Set<string>): void {
  const file = favoritesFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: FavoritesFile = { version: 1, sessionIds: [...ids].sort() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, file);
  cache = { key: statKey(file), ids };
}

/**
 * Set (or clear) the favorite mark on a session. Returns the resulting state, so
 * a caller can report it without a second read. A no-op write is skipped, which
 * keeps the file's mtime — and every other process's memoized read — untouched.
 */
export function setFavorite(sessionId: string, on: boolean): boolean {
  const ids = new Set(listFavorites());
  if (ids.has(sessionId) === on) return on;
  if (on) ids.add(sessionId);
  else ids.delete(sessionId);
  writeFavorites(ids);
  return on;
}

/** Flip the mark; returns the new state (`true` = now favorited). */
export function toggleFavorite(sessionId: string): boolean {
  return setFavorite(sessionId, !isFavorite(sessionId));
}
