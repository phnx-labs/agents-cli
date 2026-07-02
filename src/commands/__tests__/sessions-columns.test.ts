/**
 * Tests for the ticket/PR column helper (Feature 3). The ref used to jam
 * against a truncated topic inside the badge blob; ticketLabel pulls it into a
 * dedicated column, and its precedence (ticket over PR) is the bit worth
 * pinning so a session tied to both doesn't flip between them.
 */

import { describe, it, expect } from 'vitest';
import { ticketLabel, machineLabeler, formatPickerLabel, formatPickerTip } from '../sessions.js';
import type { SessionMeta } from '../../lib/session/types.js';

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, '');

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abcdef01-2345-6789-abcd-ef0123456789',
    shortId: 'abcdef01',
    agent: 'claude',
    timestamp: '2026-06-30T12:00:00.000Z',
    filePath: '/home/x/.claude/projects/foo/sess.jsonl',
    project: 'agents-cli',
    topic: 'do a thing',
    ...over,
  };
}

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

describe('machineLabeler', () => {
  it('strips the shared dash-delimited prefix (yosemite-s0/s1 -> s0/s1)', () => {
    const label = machineLabeler(['yosemite-s0', 'yosemite-s1']);
    expect(label('yosemite-s0')).toBe('s0');
    expect(label('yosemite-s1')).toBe('s1');
  });

  it('leaves ids whole when there is no shared prefix', () => {
    const label = machineLabeler(['zion', 'mac-mini']);
    expect(label('zion')).toBe('zion');
    expect(label('mac-mini')).toBe('mac-mini');
  });

  it('is identity for a single machine', () => {
    const label = machineLabeler(['yosemite-s0']);
    expect(label('yosemite-s0')).toBe('yosemite-s0');
  });

  it('never strips away the whole id', () => {
    const label = machineLabeler(['prod-1', 'prod']);
    expect(label('prod')).toBe('prod');
  });
});

describe('formatPickerLabel', () => {
  it('shows the PR ref and worktree badge when enabled', () => {
    const row = strip(formatPickerLabel(meta({ prNumber: 569, worktreeSlug: 'responsive-list' }), '', { showTicket: true }));
    expect(row).toContain('PR#569');
    expect(row).toContain('wt:responsive-list');
  });

  it('omits the ticket column when no row carries a ref', () => {
    const row = strip(formatPickerLabel(meta(), '', { showTicket: false }));
    expect(row).not.toContain('PR#');
  });

  it('renders the compact machine label only when the machine column is on', () => {
    const cols = { showMachine: true, machineLabel: machineLabeler(['yosemite-s0', 'yosemite-s1']) };
    const on = strip(formatPickerLabel(meta({ machine: 'yosemite-s0' }), '', cols));
    expect(on).toContain('s0');
    expect(on).not.toContain('yosemite-s0');

    const off = strip(formatPickerLabel(meta({ machine: 'yosemite-s0' }), '', { showMachine: false }));
    expect(off).not.toContain('s0');
  });
});

describe('formatPickerTip', () => {
  it('returns a tip and is stable for a given pool size', () => {
    const pool = [meta(), meta()];
    const a = strip(formatPickerTip(pool));
    expect(a).toContain('Tip:');
    expect(strip(formatPickerTip(pool))).toBe(a);
  });
});
