/**
 * `agents sessions optimize` — compact the FTS5 session/tool-call search index.
 *
 * The scanner delete+inserts a session's docs into the `tool_call_text` /
 * `session_text` FTS5 indexes on every rescan (and on every extractor-version
 * bump), and FTS5 never merges the resulting segments on its own. Over thousands
 * of sessions and re-index passes the `%_data` shadow tables bloat with hundreds
 * of thousands of unmerged segments — gigabytes of index for tens of MB of
 * actual content — and `agents sessions` queries slow to a crawl. This runs the
 * FTS5 `'optimize'` command to merge every segment into one and purge tombstones.
 * Non-destructive: no searchable content is lost.
 */
import type { Command } from 'commander';
import chalk from 'chalk';

import { optimizeSessionSearchIndex } from '../lib/session/db.js';
import { setHelpSections } from '../lib/help.js';

interface OptimizeOpts {
  json?: boolean;
}

export function registerSessionsOptimizeCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('optimize')
    .description('Compact the session search index (FTS5), reclaiming bloat from repeated re-indexing')
    .option('--json', 'Emit machine-readable JSON')
    .action((_opts, c: Command) => {
      const opts = c.optsWithGlobals() as OptimizeOpts;
      const results = optimizeSessionSearchIndex();
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      for (const r of results) {
        const merged = Math.max(0, r.segmentsBefore - r.segmentsAfter);
        console.log(
          `  ${chalk.cyan(r.table)}: ${r.segmentsBefore} -> ${r.segmentsAfter} segments ` +
          `(${chalk.green(merged)} merged)`,
        );
      }
      console.log(
        chalk.gray('  Reclaimed space stays as reusable pages inside the file; VACUUM (daemon stopped) returns it to disk.'),
      );
    });

  setHelpSections(cmd, {
    examples: `
      # Compact the session/tool search index once it has grown fragmented
      agents sessions optimize

      # Machine-readable segment counts
      agents sessions optimize --json

      # Wire it to a weekly routine so the index never re-bloats
      agents routines add sessions-optimize --schedule "0 4 * * 0" --agent claude \\
        --prompt "Run: agents sessions optimize"
    `,
    notes: `
      - FTS5 appends a segment on every insert and tombstones every delete; the scanner delete+inserts a session's docs on each rescan and never self-merges, so \`tool_call_text_data\` / \`session_text_data\` bloat with unmerged segments — GBs of index for tens of MB of content, and queries slow down.
      - This runs FTS5 \`'optimize'\`: it merges every segment into one and purges tombstones. Non-destructive — no searchable content is lost.
      - Reclaimed space becomes reusable free pages inside the DB file. To return it to the OS, stop the daemon (\`agents routines stop\`) and run \`VACUUM\` against \`~/.agents/.history/sessions/sessions.db\`.
    `,
  });
}
