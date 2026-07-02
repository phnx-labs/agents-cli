import { describe, it, expect } from 'vitest';
import { renderRow } from './wallet.js';
import { stringWidth } from '../lib/session/width.js';
import type { CardMetadata } from '../lib/wallet/index.js';

// renderRow appends the card id after fixed columns. The id width is gated on the
// terminal so the row never overflows — the bug this guards against is picking a
// threshold that ignores the fixed prefix (a full 36-char UUID needs >=104 cols,
// not >=100, or cols 100-103 overflow by 4). Worst case = a max-width nickname.
const card: CardMetadata = {
  id: '550e8400-e29b-41d4-a716-446655440000', // 36 chars
  nickname: 'x'.repeat(30), // longer than the 24-col nickname slot
  brand: 'amex',            // 'American Express' — the widest brand label
  last4: '4242',
  exp_month: '12',
  exp_year: '2026',
  created_at: '2026-01-01T00:00:00.000Z',
  kind: 'pan_encrypted',
};

describe('wallet renderRow', () => {
  it('never renders a row wider than the terminal', () => {
    for (const cols of [60, 79, 80, 100, 103, 104, 140, 200]) {
      expect(stringWidth(renderRow(card, cols))).toBeLessThanOrEqual(cols);
    }
  });

  it('shows the full UUID only when it actually fits (>=104 cols)', () => {
    expect(renderRow(card, 104)).toContain(card.id);
    // 100-103 must NOT show the full UUID (that was the overflow bug).
    expect(renderRow(card, 103)).not.toContain(card.id);
    // 80-103 fall back to the 8-char short id.
    expect(renderRow(card, 80)).toContain(card.id.slice(0, 8));
    // Below 80 the id column is dropped entirely.
    expect(renderRow(card, 60)).not.toContain(card.id.slice(0, 8));
  });
});
