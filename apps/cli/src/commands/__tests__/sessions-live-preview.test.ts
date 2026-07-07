/**
 * Tests for the pure helpers that enrich the default `agents sessions` listing
 * with live state (Feature 2). Correlating a historical row to the session
 * that is still running hinges on the full-UUID key, and the glyph must reflect
 * the coarse status — both are easy to get subtly wrong, so they're exercised
 * directly rather than through the chalk+console renderer.
 */

import { describe, it, expect } from 'vitest';
import { indexActiveBySessionId, liveGlyphAndPreview } from '../sessions.js';
import type { ActiveSession } from '../../lib/session/active.js';

function mk(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    ...overrides,
  };
}

describe('indexActiveBySessionId', () => {
  it('keys by the full session UUID', () => {
    const a = mk({ sessionId: 'abc12345-def6-7890-1234-567890abcdef' });
    const idx = indexActiveBySessionId([a]);
    expect(idx.get('abc12345-def6-7890-1234-567890abcdef')).toBe(a);
    // Not addressable by the 8-char short id — the caller matches on meta.id.
    expect(idx.get('abc12345')).toBeUndefined();
  });

  it('skips sessions without a sessionId (uncorrelatable probes)', () => {
    const idx = indexActiveBySessionId([
      mk({ sessionId: undefined, context: 'cloud' }),
      mk({ sessionId: 'keep-me' }),
    ]);
    expect(idx.size).toBe(1);
    expect(idx.has('keep-me')).toBe(true);
  });

  it('last write wins when a sessionId repeats', () => {
    const first = mk({ sessionId: 'dup', preview: 'first' });
    const second = mk({ sessionId: 'dup', preview: 'second' });
    const idx = indexActiveBySessionId([first, second]);
    expect(idx.get('dup')).toBe(second);
  });
});

describe('liveGlyphAndPreview', () => {
  it('returns empty strings for no live match (plain historical row)', () => {
    expect(liveGlyphAndPreview(undefined)).toEqual({ glyph: '', preview: '' });
  });

  it('running → ● and the state-engine preview', () => {
    const { glyph, preview } = liveGlyphAndPreview(mk({ status: 'running', preview: 'editing sessions.ts' }));
    expect(glyph).toContain('●');
    expect(preview).toBe('editing sessions.ts');
  });

  it('waiting on input → ◐ (both status and activity forms)', () => {
    expect(liveGlyphAndPreview(mk({ status: 'input_required' })).glyph).toContain('◐');
    expect(liveGlyphAndPreview(mk({ status: 'running', activity: 'waiting_input' })).glyph).toContain('◐');
  });

  it('idle → ○', () => {
    expect(liveGlyphAndPreview(mk({ status: 'idle' })).glyph).toContain('○');
  });

  it('preview falls back to label then topic when there is no live preview', () => {
    expect(liveGlyphAndPreview(mk({ status: 'running', label: 'my-task' })).preview).toBe('my-task');
    expect(liveGlyphAndPreview(mk({ status: 'running', topic: 'first prompt' })).preview).toBe('first prompt');
  });
});
