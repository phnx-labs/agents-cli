/**
 * Counter / warehouse mix recipes under `agents insights`.
 *
 * These used to live as the top-level `agents trends` tree. That name was a
 * peer of `agents insights` with overlapping "analytics" meaning, so agents and
 * humans kept picking the wrong verb. The cheap counter path (sessions index +
 * usage.db) still exists — it is now `agents insights mix` and the recipe
 * subcommands below. Latency stays on `agents perf`; quota on `agents view`.
 *
 * Former top-level `agents trends` is gone. The nested spelling
 * `agents insights trends` is an alias of `agents insights mix`.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../help.js';
import {
  buildMixDashboard,
  analyticsWindow,
  runRecipe,
  RECIPE_IDS,
  type RecipeId,
} from './dashboard.js';
import { listRecipes } from './recipes.js';
import { queryUsage, usageDbPath, type UsageKind, USAGE_KINDS } from './usage-db.js';

interface MixOpts {
  days?: string;
  json?: boolean;
  limit?: string;
}

export function parseMixDays(raw: string | undefined): number {
  const n = parseInt(raw ?? '7', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function printMixSection(section: {
  id: string;
  title: string;
  rows: Array<Record<string, string | number | null>>;
}): void {
  console.log(chalk.bold(section.title));
  if (section.rows.length === 0) {
    console.log(chalk.gray('  (no data)'));
    console.log();
    return;
  }
  const keys = Object.keys(section.rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...section.rows.map((r) => String(r[k] ?? '').length), 4));
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
  console.log(chalk.gray(keys.map((k, i) => pad(k.toUpperCase(), widths[i])).join('  ')));
  for (const row of section.rows) {
    console.log(keys.map((k, i) => pad(String(row[k] ?? ''), widths[i])).join('  '));
  }
  console.log();
}

export function renderMixDashboard(days: number, asJson: boolean, bannerLabel = 'agents insights mix'): void {
  const dash = buildMixDashboard({ days });
  if (asJson) {
    console.log(JSON.stringify(dash, null, 2));
    return;
  }
  console.log(chalk.bold(`${bannerLabel} — last ${dash.window.days} days`));
  console.log(chalk.gray(`compute ${dash.durationMs}ms · usage ${usageDbPath()}`));
  console.log();
  if (dash.sections.length === 0) {
    console.log(chalk.gray('No session or usage data in this window yet.'));
    return;
  }
  for (const section of dash.sections) printMixSection(section);
}

/**
 * Attach counter-mix subcommands to a parent (typically `insights`).
 *
 * Layout:
 *   <parent> mix                 multi-recipe board
 *   <parent> trends              alias of mix (former top-level `agents trends`)
 *   <parent> recipes             list recipe ids
 *   <parent> query               raw usage.db rows
 *   <parent> harness-mix|…       one baked recipe
 */
export function registerMixCommands(parent: Command): void {
  const banner = 'agents insights mix';

  const mix = parent
    .command('mix')
    .description('Counter recipes — harness/model mix, token ratios, resource frequency (sessions index + usage.db)')
    .option('--days <n>', 'Days of history to include', '7')
    .option('--json', 'Emit JSON instead of tables')
    .action(function summary(this: Command) {
      const o = this.opts() as MixOpts;
      renderMixDashboard(parseMixDays(o.days), Boolean(o.json), banner);
    });

  setHelpSections(mix, {
    examples: `
      # Auto recipe board (7d)
      agents insights mix

      # Last 30 days
      agents insights mix --days 30

      # One recipe as JSON
      agents insights harness-mix --json

      # Raw usage events
      agents insights query --kind secret --days 7

      # List baked recipe ids
      agents insights recipes
    `,
    notes: `
      Session recipes read sessions.db; resource recipes read ~/.agents/.history/analytics/usage.db.
      Empty recipes are skipped on the default mix board.
      This is the cheap counter path. Behavioural report (transcript content, account split)
      is bare \`agents insights\`. Latency is \`agents perf\`; quota is \`agents view\`.
      Skill/slash-command popularity is \`agents sessions stats\`.
    `,
  });

  parent.command('recipes')
    .description('List baked mix-recipe ids')
    .option('--json', 'Emit JSON')
    .action((o: { json?: boolean }) => {
      const list = listRecipes();
      if (o.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      for (const r of list) {
        console.log(`${r.id.padEnd(22)} ${r.store.padEnd(10)} ${r.title}`);
      }
    });

  parent.command('query')
    .description('Raw usage-event query (usage.db)')
    .option('--kind <kind>', `One of: ${USAGE_KINDS.join(', ')}`)
    .option('--name <name>', 'Resource name filter')
    .option('--event <event>', 'Event name filter')
    .option('--days <n>', 'Days of history', '7')
    .option('--limit <n>', 'Max rows', '40')
    .option('--json', 'Emit JSON')
    .action((o: { kind?: string; name?: string; event?: string; days?: string; limit?: string; json?: boolean }) => {
      const win = analyticsWindow(parseMixDays(o.days));
      const kind = o.kind && (USAGE_KINDS as readonly string[]).includes(o.kind)
        ? o.kind as UsageKind
        : undefined;
      if (o.kind && !kind) {
        console.error(`Unknown kind '${o.kind}'. Expected: ${USAGE_KINDS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const rows = queryUsage({
        kind,
        name: o.name,
        event: o.event,
        sinceIso: win.sinceIso,
        limit: parseLimit(o.limit, 40),
      });
      if (o.json) {
        console.log(JSON.stringify({ window: win, rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.gray('No usage events.'));
        return;
      }
      printMixSection({
        id: 'query',
        title: 'Usage events',
        rows: rows.map((r) => ({
          ts: r.ts,
          kind: r.kind,
          name: r.name,
          event: r.event,
          agent: r.agent,
        })),
      });
    });

  for (const id of RECIPE_IDS) {
    parent.command(id)
      .description(`Mix recipe: ${id}`)
      .option('--days <n>', 'Days of history', '7')
      .option('--json', 'Emit JSON')
      .action(function recipeAction(this: Command) {
        const parentOpts = this.parent?.opts?.() as MixOpts | undefined;
        const o = { ...parentOpts, ...(this.opts() as MixOpts) };
        const win = analyticsWindow(parseMixDays(o.days));
        const section = runRecipe(id as RecipeId, win);
        if (o.json) {
          console.log(JSON.stringify({ window: win, section }, null, 2));
          return;
        }
        if (section.empty) {
          console.log(chalk.gray(`No data for recipe '${id}' in the last ${win.days} days.`));
          return;
        }
        printMixSection(section);
      });
  }

  // Nested home for the former top-level `agents trends` spelling.
  const trends = parent
    .command('trends')
    .description('Alias of `mix` — former top-level `agents trends`')
    .option('--days <n>', 'Days of history to include', '7')
    .option('--json', 'Emit JSON instead of tables')
    .action(function summary(this: Command) {
      const o = this.opts() as MixOpts;
      renderMixDashboard(parseMixDays(o.days), Boolean(o.json), banner);
    });
  setHelpSections(trends, {
    examples: `
      agents insights trends
      agents insights mix
    `,
    notes: `
      \`agents insights trends\` is the nested spelling of the former top-level
      \`agents trends\`. Prefer \`agents insights mix\`.
    `,
  });
}
