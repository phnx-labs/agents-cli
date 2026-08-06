/**
 * Deprecated top-level spelling of the counter-mix tree.
 *
 * Implementation lives under `agents insights mix` (see
 * `lib/analytics/mix-commands.ts`). This file only registers the thin alias so
 * old scripts and agent briefs keep working while printing one deprecation line
 * — no second recipe implementation.
 */

import type { Command } from 'commander';
import { registerDeprecatedTrendsAlias } from '../lib/analytics/mix-commands.js';

export function registerTrendsCommand(program: Command): void {
  registerDeprecatedTrendsAlias(program);
}
