import { describe, it, expect } from 'vitest';
import { COMPARISON_HTML } from '../src/comparison';

const COLUMN_HEADERS = [
  'agents-cli',
  'Claude Code alone',
  'Cursor',
  'Run CLIs by hand',
  'OpenCode',
];

const CAPABILITY_ROWS = [
  'Pin versions per project (.nvmrc-style)',
  'Run multiple agents (Claude + Codex + Gemini) from one CLI',
  'Swap underlying model (Kimi, GLM, DeepSeek via OpenRouter)',
  'Rotate across multiple accounts to dodge rate limits',
  'Parallel teams with DAG dependencies',
  'Local browser via CDP (drive any site)',
  'Cross-agent session search &amp; replay',
  'Cron / scheduled routines',
  'Keychain-backed secrets (no .env files)',
  'Sync skills/MCP/commands across all installed agents',
  '100% local, open-source, no cloud SaaS',
];

describe('COMPARISON_HTML', () => {
  it('is a non-empty string', () => {
    expect(typeof COMPARISON_HTML).toBe('string');
    expect(COMPARISON_HTML.length).toBeGreaterThan(0);
  });

  it('contains all five column headers', () => {
    for (const header of COLUMN_HEADERS) {
      expect(COMPARISON_HTML).toContain(header);
    }
  });

  it('contains every capability row', () => {
    for (const row of CAPABILITY_ROWS) {
      expect(COMPARISON_HTML).toContain(row);
    }
  });

  it('scopes every class with the cmp- prefix', () => {
    const classMatches = COMPARISON_HTML.match(/class="([^"]+)"/g) ?? [];
    expect(classMatches.length).toBeGreaterThan(0);
    for (const m of classMatches) {
      const classes = m.slice('class="'.length, -1).split(/\s+/).filter(Boolean);
      for (const cls of classes) {
        expect(cls).toMatch(/^cmp-/);
      }
    }
  });
});
