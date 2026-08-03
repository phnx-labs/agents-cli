import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-favorites-'));
process.env.HOME = TEST_HOME;

const { listFavorites, isFavorite, setFavorite, toggleFavorite, favoritesFilePath, clearFavoritesCache } =
  await import('./favorites.js');

/**
 * Favorites are the one piece of per-session state a human ASSERTS rather than
 * the scanner deriving, so the properties that matter are durability (a real
 * file, atomically written, surviving a reindex of the session cache) and that
 * a corrupt or absent file degrades to "nothing is starred" instead of taking
 * `agents sessions` down with it.
 */
describe('session favorites', () => {
  it('round-trips a star through the real file and reports it back', () => {
    expect(isFavorite('sid-a')).toBe(false);
    expect(setFavorite('sid-a', true)).toBe(true);
    expect(isFavorite('sid-a')).toBe(true);
    expect([...listFavorites()]).toEqual(['sid-a']);
    // The store is a real file on disk, not process state.
    const onDisk = JSON.parse(fs.readFileSync(favoritesFilePath(), 'utf8'));
    expect(onDisk.sessionIds).toContain('sid-a');
    expect(onDisk.version).toBe(1);
  });

  it('toggles, and unstarring removes the id rather than keeping a false entry', () => {
    setFavorite('sid-b', true);
    expect(toggleFavorite('sid-b')).toBe(false);
    expect(isFavorite('sid-b')).toBe(false);
    expect(JSON.parse(fs.readFileSync(favoritesFilePath(), 'utf8')).sessionIds).not.toContain('sid-b');
    expect(toggleFavorite('sid-b')).toBe(true);
    expect(isFavorite('sid-b')).toBe(true);
  });

  it('is idempotent — a redundant set leaves the file untouched', () => {
    setFavorite('sid-c', true);
    const before = fs.statSync(favoritesFilePath()).mtimeMs;
    expect(setFavorite('sid-c', true)).toBe(true);
    expect(fs.statSync(favoritesFilePath()).mtimeMs).toBe(before);
  });

  it('picks up a file another process rewrote (the memoized read is mtime-keyed)', () => {
    setFavorite('sid-d', true);
    expect(isFavorite('sid-d')).toBe(true);
    // Simulate a peer/sync writing the file underneath us.
    fs.writeFileSync(favoritesFilePath(), JSON.stringify({ version: 1, sessionIds: ['sid-elsewhere'] }));
    clearFavoritesCache();
    expect(isFavorite('sid-d')).toBe(false);
    expect(isFavorite('sid-elsewhere')).toBe(true);
  });

  it('treats a malformed or absent store as empty instead of throwing', () => {
    fs.writeFileSync(favoritesFilePath(), '{ this is not json');
    clearFavoritesCache();
    expect(listFavorites().size).toBe(0);
    // Non-string entries are dropped, not trusted into the set.
    fs.writeFileSync(favoritesFilePath(), JSON.stringify({ version: 1, sessionIds: ['ok', 42, null, ''] }));
    clearFavoritesCache();
    expect([...listFavorites()]).toEqual(['ok']);
    fs.rmSync(favoritesFilePath());
    clearFavoritesCache();
    expect(listFavorites().size).toBe(0);
    expect(isFavorite('anything')).toBe(false);
  });

  it('never treats an absent session id as favorited', () => {
    expect(isFavorite(undefined)).toBe(false);
    expect(isFavorite('')).toBe(false);
  });
});
