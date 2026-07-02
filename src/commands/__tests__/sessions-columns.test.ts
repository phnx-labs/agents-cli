/**
 * Tests for the ticket/PR column helper (Feature 3). The ref used to jam
 * against a truncated topic inside the badge blob; ticketLabel pulls it into a
 * dedicated column, and its precedence (ticket over PR) is the bit worth
 * pinning so a session tied to both doesn't flip between them.
 */

import { describe, it, expect } from 'vitest';
import { ticketLabel } from '../sessions.js';

describe('ticketLabel', () => {
  it('returns the tracker ticket id when present', () => {
    expect(ticketLabel({ ticketId: 'RUSH-1332', prNumber: undefined })).toBe('RUSH-1332');
  });

  it('falls back to PR#<n> when there is no ticket', () => {
    expect(ticketLabel({ ticketId: undefined, prNumber: 565 })).toBe('PR#565');
  });

  it('prefers the ticket over the PR when both are set', () => {
    expect(ticketLabel({ ticketId: 'RUSH-1332', prNumber: 565 })).toBe('RUSH-1332');
  });

  it('returns empty string when neither is set', () => {
    expect(ticketLabel({ ticketId: undefined, prNumber: undefined })).toBe('');
  });
});
