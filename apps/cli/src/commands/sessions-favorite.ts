/**
 * `agents sessions favorite` — the non-TTY half of the star.
 *
 * The `*` hotkey in the interactive browser is how a human stars a session; this
 * is how a script, an agent, or a machine without a TTY does the same thing, and
 * it is what makes the feature testable end to end without driving a terminal UI.
 * Both write the one store in `lib/session/favorites.ts`.
 */

import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { findSessionsById } from '../lib/session/db.js';
import { isCompleteSessionId } from '../lib/session/discover.js';
import { isFavorite, listFavorites, setFavorite } from '../lib/session/favorites.js';

interface FavoriteOptions {
  remove?: boolean;
  list?: boolean;
}

/**
 * Resolve one user-typed id (usually the 8-char short id the listing prints) to
 * a full session id. Ambiguity is an ERROR, not a silent first-match: starring
 * the wrong session is invisible until the user wonders where their star went.
 */
export function resolveFavoriteTarget(idQuery: string): { id: string } | { error: string } {
  const matches = findSessionsById(idQuery);
  // A COMPLETE id needs no index entry: the id is the key the store is built on,
  // and requiring a transcript row would refuse exactly the newest sessions — a
  // live one that has not been indexed yet. The browser's `*` stars those from
  // the live row, so demanding a DB hit here would make the two disagree.
  if (matches.length === 0) {
    return isCompleteSessionId(idQuery.trim())
      ? { id: idQuery.trim() }
      : { error: `No session matches "${idQuery}".` };
  }
  if (matches.length > 1) {
    const ids = matches.slice(0, 5).map((m) => m.shortId).join(', ');
    return { error: `"${idQuery}" matches ${matches.length} sessions (${ids}…) — use a longer id.` };
  }
  return { id: matches[0].id };
}

export function registerSessionsFavoriteCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('favorite')
    .argument('[ids...]', 'Session ids to star (full or short id prefix)')
    .description('Star sessions so they are easy to find again — list them with --favorites, or `f` in the browser.')
    .option('--remove', 'Unstar the given sessions instead of starring them')
    .option('--list', 'List the starred sessions (the default when no ids are given)')
    .option('--json', 'Output JSON');

  setHelpSections(cmd, {
    examples: `
      # Star a session by its short id (the 8 chars the listing prints)
      agents sessions favorite 26c27162

      # See what is starred
      agents sessions favorite --list

      # Browse only the starred ones
      agents sessions --favorites

      # Unstar it again
      agents sessions favorite 26c27162 --remove
    `,
    notes: `
      In the interactive browser (\`agents sessions\`), \`*\` stars the highlighted
      session and \`f\` filters the list down to the starred ones.

      Stars live in ~/.agents/.history/favorites.json, keyed by session id, so
      they survive a reindex of the session cache. They are per-machine: session
      sync carries transcripts, not this file.
    `,
  });

  cmd.action((ids: string[], options: FavoriteOptions, self: Command) => {
    // `--json` has to come from the merged view, not `options`. The parent
    // `sessions` command declares `--json` AND takes a positional `[query]`, so
    // commander keeps parsing parent-known options past the subcommand name and
    // binds `--json` to the PARENT — `options.json` is silently undefined here
    // while `--remove`/`--list` (unknown to the parent) arrive fine.
    // `optsWithGlobals` is commander's own answer for reading an option a parent
    // owns; it is still declared on this command so `--help` documents it.
    const json = (self.optsWithGlobals() as { json?: boolean }).json === true;
    if (options.list || ids.length === 0) {
      const starred = [...listFavorites()].sort();
      if (json) {
        process.stdout.write(JSON.stringify({ favorites: starred }, null, 2) + '\n');
        return;
      }
      if (starred.length === 0) {
        console.log(chalk.gray('No favorited sessions. Star one with `agents sessions favorite <id>`.'));
        return;
      }
      for (const id of starred) console.log(`${chalk.yellow('★')} ${id}`);
      console.log(chalk.gray(`\n${starred.length} favorite${starred.length === 1 ? '' : 's'}.`));
      return;
    }

    const on = !options.remove;
    const results: { query: string; id?: string; favorite?: boolean; error?: string }[] = [];
    for (const idQuery of ids) {
      const resolved = resolveFavoriteTarget(idQuery);
      if ('error' in resolved) {
        results.push({ query: idQuery, error: resolved.error });
        continue;
      }
      // Unstarring something that was never starred, or starring it twice, is a
      // no-op the store already short-circuits — report the resulting state.
      setFavorite(resolved.id, on);
      results.push({ query: idQuery, id: resolved.id, favorite: isFavorite(resolved.id) });
    }

    if (json) {
      process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
    } else {
      for (const r of results) {
        if (r.error) console.error(chalk.red(r.error));
        else console.log(`${r.favorite ? chalk.yellow('★ favorited') : chalk.gray('☆ unfavorited')} ${r.id}`);
      }
    }
    // A failed lookup is a failed command — a script must not read "starred" from
    // a zero exit when nothing was starred.
    if (results.some((r) => r.error)) process.exitCode = 1;
  });
}
