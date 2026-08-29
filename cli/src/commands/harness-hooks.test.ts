import { describe, it, expect } from 'vitest';
import { buildModelChoices } from './harness-hooks.js';
import type { ModelInfo } from '../lib/models.js';

/**
 * The model catalog pick (RUSH-2220) turns a host's `getModelCatalog` list into
 * `select` choices. `buildModelChoices` is the pure labelling core — the catalog
 * probe itself shells out and is exercised end-to-end, but the choice shape (the
 * always-present escape hatch, the edit-mode keep row, tier/alias hints) is
 * asserted here with no probe.
 */
const model = (over: Partial<ModelInfo>): ModelInfo => ({ id: 'x', ...over });

describe('buildModelChoices — catalog list → select choices', () => {
  it('lists every catalog model and always appends a custom-id escape hatch', () => {
    const choices = buildModelChoices([model({ id: 'a' }), model({ id: 'b' })]);
    const values = choices.map((c) => c.value);
    expect(values).toContain('a');
    expect(values).toContain('b');
    // The last row is always the free-text escape, so a model the catalog omits
    // is still reachable.
    expect(choices[choices.length - 1].name).toMatch(/custom model id/i);
  });

  it('leads with a keep-current row only in edit mode (when a current value is given)', () => {
    const withCurrent = buildModelChoices([model({ id: 'a' })], 'a');
    expect(withCurrent[0].name).toMatch(/Keep current \(a\)/);

    const withoutCurrent = buildModelChoices([model({ id: 'a' })]);
    expect(withoutCurrent[0].name).not.toMatch(/Keep current/);
  });

  it('annotates the default model and any alias in the row label', () => {
    const choices = buildModelChoices([
      model({ id: 'claude-opus-4-8', alias: 'opus', isDefault: true }),
    ]);
    const row = choices.find((c) => c.value === 'claude-opus-4-8')!;
    expect(row.name).toContain('opus');
    expect(row.name).toContain('default');
  });
});
