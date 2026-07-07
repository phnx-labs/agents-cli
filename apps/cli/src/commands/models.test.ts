import { describe, expect, it } from 'vitest';
import { formatModelAliasLines, formatModelSourceLine, formatModelSummaryLine } from './models.js';
import { stringWidth, stripAnsi } from '../lib/session/width.js';

describe('models responsive formatting', () => {
  it('truncates the source path to the requested width', () => {
    const line = formatModelSourceLine('bundle', '~/very/long/path/inside/a/version/home/models/catalog.json', 44);
    expect(stringWidth(line)).toBeLessThanOrEqual(44);
    expect(line).toMatch(/^  source: bundle \(/);
  });

  it('wraps aliases under a hanging indent', () => {
    const lines = formatModelAliasLines([
      'opus=claude-opus-4-20250514',
      'sonnet=claude-sonnet-4-20250514',
      'haiku=claude-haiku-4-20250514',
    ], 54);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => stringWidth(line) <= 54)).toBe(true);
    expect(stripAnsi(lines[1]).startsWith('           ')).toBe(true);
  });

  it('caps model id and display name rows', () => {
    const line = formatModelSummaryLine('*', 'provider/super-long-model-id-with-extra-suffix', 'A display name that is also too long', 'daily-driver', 60);
    expect(stringWidth(line)).toBeLessThanOrEqual(60);
    expect(stripAnsi(line)).toContain('provider/super-long-model-id');
  });
});
