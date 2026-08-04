import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { buildTrendsDashboard, trendsWindow, runRecipe, RECIPE_IDS, type RecipeId } from '../lib/analytics/dashboard.js';
import { listRecipes } from '../lib/analytics/recipes.js';
import { queryUsage, usageDbPath, type UsageKind, USAGE_KINDS } from '../lib/analytics/usage-db.js';

interface TrendsOpts {
  days?: string;
  json?: boolean;
  limit?: string;
}

function parseDays(raw: string | undefined): number {
  const n = parseInt(raw ?? '7', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function printSection(section: { id: string; title: string; rows: Array<Record<string, string | number | null>> }): void {
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

function renderDashboard(days: number, asJson: boolean): void {
  const dash = buildTrendsDashboard({ days });
  if (asJson) {
    console.log(JSON.stringify(dash, null, 2));
    return;
  }
  console.log(chalk.bold(`agents trends — last ${dash.window.days} days`));
  console.log(chalk.gray(`compute ${dash.durationMs}ms · usage ${usageDbPath()}`));
  console.log();
  if (dash.sections.length === 0) {
    console.log(chalk.gray('No session or usage data in this window yet.'));
    return;
  }
  for (const section of dash.sections) printSection(section);
}

export function registerTrendsCommand(program: Command): void {
  const trends = program
    .command('trends')
    .description('Usage analytics — harness/model mix, token ratios, resource frequency')
    .option('--days <n>', 'Days of history to include', '7')
    .option('--json', 'Emit JSON instead of tables')
    .action(function summary(this: Command) {
      const opts = this.opts() as TrendsOpts;
      renderDashboard(parseDays(opts.days), Boolean(opts.json));
    });

  setHelpSections(trends, {
    examples: `
      # Auto recipe dashboard (7d)
      agents trends

      # Last 30 days
      agents trends --days 30

      # One recipe as JSON
      agents trends harness-mix --json

      # Raw usage events
      agents trends query --kind secret --days 7

      # List baked recipe ids
      agents trends recipes
    `,
    notes: `
      Session recipes read sessions.db; resource recipes read ~/.agents/.history/analytics/usage.db.
      Empty recipes are skipped on the default dashboard.
      Quota / rate-limits remain on \`agents usage\`; latency on \`agents perf\`.
    `,
  });

  trends.command('recipes')
    .description('List baked recipe ids')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => {
      const list = listRecipes();
      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      for (const r of list) {
        console.log(`${r.id.padEnd(22)} ${r.store.padEnd(10)} ${r.title}`);
      }
    });

  trends.command('query')
    .description('Raw usage-event query')
    .option('--kind <kind>', `One of: ${USAGE_KINDS.join(', ')}`)
    .option('--name <name>', 'Resource name filter')
    .option('--event <event>', 'Event name filter')
    .option('--days <n>', 'Days of history', '7')
    .option('--limit <n>', 'Max rows', '40')
    .option('--json', 'Emit JSON')
    .action((opts: { kind?: string; name?: string; event?: string; days?: string; limit?: string; json?: boolean }) => {
      const win = trendsWindow(parseDays(opts.days));
      const kind = opts.kind && (USAGE_KINDS as readonly string[]).includes(opts.kind)
        ? opts.kind as UsageKind
        : undefined;
      if (opts.kind && !kind) {
        console.error(`Unknown kind '${opts.kind}'. Expected: ${USAGE_KINDS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const rows = queryUsage({
        kind,
        name: opts.name,
        event: opts.event,
        sinceIso: win.sinceIso,
        limit: parseLimit(opts.limit, 40),
      });
      if (opts.json) {
        console.log(JSON.stringify({ window: win, rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.gray('No usage events.'));
        return;
      }
      printSection({
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
    trends.command(id)
      .description(`Recipe: ${id}`)
      .option('--days <n>', 'Days of history', '7')
      .option('--json', 'Emit JSON')
      .action(function recipeAction(this: Command) {
        const parent = this.parent?.opts?.() as TrendsOpts | undefined;
        const opts = { ...parent, ...(this.opts() as TrendsOpts) };
        const win = trendsWindow(parseDays(opts.days));
        const section = runRecipe(id as RecipeId, win);
        if (opts.json) {
          console.log(JSON.stringify({ window: win, section }, null, 2));
          return;
        }
        if (section.empty) {
          console.log(chalk.gray(`No data for recipe '${id}' in the last ${win.days} days.`));
          return;
        }
        printSection(section);
      });
  }
}
