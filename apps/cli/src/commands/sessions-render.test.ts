import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import type { SessionAgentId, SessionMeta } from '../lib/session/types.js';
import { MARKDOWN_RENDER_AGENTS, renderSessionMarkdownDocument } from './sessions-render.js';

const TESTDATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/session/testdata/render');

const FIXTURES: Record<(typeof MARKDOWN_RENDER_AGENTS)[number], string> = {
  claude: path.join(TESTDATA, 'claude.jsonl'),
  codex: path.join(TESTDATA, 'codex.jsonl'),
  kimi: path.join(TESTDATA, 'kimi', 'state.json'),
  grok: path.join(TESTDATA, 'grok', 'summary.json'),
  cursor: path.join(TESTDATA, 'cursor.jsonl'),
  droid: path.join(TESTDATA, 'droid.jsonl'),
};

function meta(agent: SessionAgentId, filePath: string): SessionMeta {
  return {
    id: `render-${agent}`,
    shortId: `render-${agent}`,
    agent,
    timestamp: '2026-08-03T10:00:00.000Z',
    lastActivity: '2026-08-03T10:00:04.000Z',
    cwd: '/Users/alice/private',
    project: 'private-project',
    topic: `Deploy the ${agent} session`,
    filePath,
    messageCount: 2,
    tokenCount: 42,
    prUrl: 'https://github.com/phnx-labs/agents-cli/pull/123',
    prNumber: 123,
  };
}

describe('sessions render harness parity', () => {
  it('pins the complete supported-harness set', () => {
    expect(MARKDOWN_RENDER_AGENTS).toEqual(['claude', 'codex', 'kimi', 'grok', 'cursor', 'droid']);
    expect(Object.keys(FIXTURES)).toEqual([...MARKDOWN_RENDER_AGENTS]);
  });

  for (const agent of MARKDOWN_RENDER_AGENTS) {
    it(`renders ${agent} through the shared parser and redactor`, () => {
      const markdown = renderSessionMarkdownDocument(meta(agent, FIXTURES[agent]));
      expect(markdown).toContain('## Session preview');
      expect(markdown).toMatch(/^# Deploy /);
      expect(markdown).toContain('## Conversation');
      expect(markdown).toContain('## User');
      expect(markdown).toContain('## Assistant');
      expect(markdown).toContain('### Tool:');
      expect(markdown).toContain('```bash');
      expect(markdown).toContain('TOKEN=[REDACTED]');
      expect(markdown).not.toContain('fixture-secret');
      expect(markdown).not.toContain('/Users/alice');
      expect(markdown).toContain('[HOME]/private');
    });
  }

  it('fails loudly for an unsupported harness', () => {
    expect(() => renderSessionMarkdownDocument(meta('gemini', path.join(TESTDATA, 'claude.jsonl'))))
      .toThrow(/supports claude, codex, kimi, grok, cursor, droid/);
  });

  it('omits harness-injected user scaffolding from the shareable document', () => {
    const markdown = renderSessionMarkdownDocument(meta('codex', FIXTURES.codex));
    expect(markdown).not.toContain('internal scaffold');
  });

  it('lets the renderer truncate full normalized output with an exact note', () => {
    const markdown = renderSessionMarkdownDocument(meta('codex', FIXTURES.codex), {
      maxToolOutputChars: 20,
    });
    expect(markdown).toContain('[Output truncated: 580 characters omitted.]');
  });
});
