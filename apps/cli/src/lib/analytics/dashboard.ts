import {
  RECIPE_IDS,
  runRecipe,
  trendsWindow,
  type RecipeId,
  type RecipeSection,
  type TrendsWindow,
} from './recipes.js';

export interface TrendsDashboard {
  window: TrendsWindow;
  durationMs: number;
  sections: RecipeSection[];
}

const DEFAULT_ORDER: RecipeId[] = [
  'harness-mix',
  'model-mix',
  'session-volume',
  'token-ratio',
  'tools-per-session',
  'secrets-hot',
  'browser-activity',
  'resource-mix',
];

export function buildTrendsDashboard(opts: { days?: number; ids?: RecipeId[] } = {}): TrendsDashboard {
  const t0 = Date.now();
  const win = trendsWindow(opts.days ?? 7);
  const ids = opts.ids ?? DEFAULT_ORDER;
  const sections: RecipeSection[] = [];
  for (const id of ids) {
    if (!RECIPE_IDS.includes(id)) continue;
    const section = runRecipe(id, win);
    if (section.empty) continue;
    sections.push(section);
  }
  return {
    window: win,
    durationMs: Date.now() - t0,
    sections,
  };
}

export { trendsWindow, runRecipe, RECIPE_IDS, type RecipeId, type RecipeSection };
