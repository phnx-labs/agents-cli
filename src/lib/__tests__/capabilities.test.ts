import { describe, it, expect } from 'vitest';
import { supports, isCapable, capableAgents, explainSkip } from '../capabilities.js';

describe('supports() capability gate', () => {
  describe('agent-level (no version)', () => {
    it('returns ok for capabilities marked true', () => {
      expect(supports('claude', 'hooks')).toEqual({ ok: true });
      expect(supports('claude', 'mcp')).toEqual({ ok: true });
    });

    it('returns unsupported for capabilities marked false', () => {
      expect(supports('cursor', 'hooks')).toEqual({ ok: false, reason: 'unsupported' });
      expect(supports('amp', 'plugins')).toEqual({ ok: false, reason: 'unsupported' });
    });

    it('returns ok for object-form caps when version omitted', () => {
      // codex.hooks is { since: '0.116.0' }; with no version the agent-level
      // check returns ok -- callers must pass a version to actually gate.
      expect(supports('codex', 'hooks')).toEqual({ ok: true });
      expect(supports('gemini', 'hooks')).toEqual({ ok: true });
    });
  });

  describe('codex hooks since 0.116.0', () => {
    it('gates 0.115.x as too_old', () => {
      const result = supports('codex', 'hooks', '0.115.9');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('too_old');
        expect(result.need).toBe('>= 0.116.0');
      }
    });

    it('gates 0.113.0 as too_old', () => {
      const result = supports('codex', 'hooks', '0.113.0');
      expect(result.ok).toBe(false);
    });

    it('passes 0.116.0 exactly', () => {
      expect(supports('codex', 'hooks', '0.116.0')).toEqual({ ok: true });
    });

    it('passes 0.117.0 and above', () => {
      expect(supports('codex', 'hooks', '0.117.0')).toEqual({ ok: true });
      expect(supports('codex', 'hooks', '1.0.0')).toEqual({ ok: true });
    });
  });

  describe('gemini hooks since 0.26.0', () => {
    it('gates 0.25.1 as too_old (the silent-no-op case)', () => {
      const result = supports('gemini', 'hooks', '0.25.1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('too_old');
        expect(result.need).toBe('>= 0.26.0');
      }
    });

    it('passes 0.26.0 exactly', () => {
      expect(supports('gemini', 'hooks', '0.26.0')).toEqual({ ok: true });
    });

    it('passes 1.0.0', () => {
      expect(supports('gemini', 'hooks', '1.0.0')).toEqual({ ok: true });
    });
  });

  describe('unsupported agents skip regardless of version', () => {
    it('cursor hooks always unsupported', () => {
      expect(supports('cursor', 'hooks', '999.0.0').ok).toBe(false);
    });

    it('opencode plugins always unsupported (writer not implemented)', () => {
      expect(supports('opencode', 'plugins', '999.0.0').ok).toBe(false);
    });
  });
});

describe('isCapable()', () => {
  it('reports true for any non-false capability', () => {
    expect(isCapable('claude', 'hooks')).toBe(true);
    expect(isCapable('codex', 'hooks')).toBe(true); // object form counts
    expect(isCapable('gemini', 'hooks')).toBe(true);
  });

  it('reports false for explicit false', () => {
    expect(isCapable('cursor', 'hooks')).toBe(false);
    expect(isCapable('opencode', 'plugins')).toBe(false);
  });
});

describe('capableAgents()', () => {
  it('includes claude/codex/gemini/openclaw for hooks', () => {
    const agents = capableAgents('hooks');
    expect(agents).toContain('claude');
    expect(agents).toContain('codex');
    expect(agents).toContain('gemini');
    expect(agents).toContain('openclaw');
  });

  it('excludes cursor/opencode/copilot/amp for hooks', () => {
    const agents = capableAgents('hooks');
    expect(agents).not.toContain('cursor');
    expect(agents).not.toContain('opencode');
    expect(agents).not.toContain('copilot');
    expect(agents).not.toContain('amp');
  });
});

describe('explainSkip()', () => {
  it('formats unsupported message', () => {
    const r = supports('cursor', 'hooks');
    expect(explainSkip('cursor', 'hooks', r)).toBe('cursor: hooks not supported');
  });

  it('formats too_old message with version', () => {
    const r = supports('gemini', 'hooks', '0.25.0');
    expect(explainSkip('gemini', 'hooks', r, '0.25.0'))
      .toBe('gemini@0.25.0: hooks requires >= 0.26.0');
  });

  it('returns empty string when ok', () => {
    expect(explainSkip('claude', 'hooks', { ok: true })).toBe('');
  });
});
