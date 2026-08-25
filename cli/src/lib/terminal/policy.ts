/**
 * Layout policy — how a batch of surfaces is arranged.
 *
 * `two-per-tab` (default) packs sessions two-up: session 1 opens a new tab,
 * session 2 splits it (right), session 3 opens a new tab, and so on — so each
 * tab holds a left+right pair. `tabs` gives every session its own tab.
 */
import type { Layout } from './types.js';

export type Packing = 'two-per-tab' | 'tabs';

/** Assign a layout to each index in a batch of `count` surfaces. */
export function planLayouts(count: number, packing: Packing = 'two-per-tab'): Layout[] {
  const out: Layout[] = [];
  for (let i = 0; i < count; i++) {
    if (packing === 'tabs') out.push('tab');
    else out.push(i % 2 === 0 ? 'tab' : 'split-right');
  }
  return out;
}
