/**
 * The session preview header surfaces the worked-on ticket and the PR the
 * session opened, so a reviewer can jump straight to Linear / GitHub from the
 * browser. Both are rendered by `buildPreview` (via `formatHeader`); we assert
 * the labels appear rather than the OSC 8 escape, which is TTY-gated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { buildPreview } from './sessions-picker.js';
import { _resetLinearWorkspaceCache } from '../lib/session/linear.js';
import type { SessionMeta } from '../lib/session/types.js';

function mk(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: 'link-test-' + Math.random().toString(36).slice(2),
    shortId: 'linktest',
    agent: 'claude',
    // No filePath → buildPreview takes the metadata-only branch, which still
    // renders the header (and thus the ticket/PR line) without parsing a file.
    ...overrides,
  } as SessionMeta;
}

describe('buildPreview — ticket + PR links line', () => {
  const savedEnv = process.env.LINEAR_WORKSPACE;
  beforeEach(() => {
    _resetLinearWorkspaceCache();
    process.env.LINEAR_WORKSPACE = 'acme';
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LINEAR_WORKSPACE;
    else process.env.LINEAR_WORKSPACE = savedEnv;
    _resetLinearWorkspaceCache();
  });

  it('shows the ticket id and PR number in the preview', () => {
    const preview = stripVTControlCharacters(
      buildPreview(mk({ ticketId: 'RUSH-1864', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 })),
    );
    expect(preview).toContain('RUSH-1864');
    expect(preview).toContain('PR#42');
  });

  it('embeds the canonical Linear + GitHub URLs as OSC 8 hyperlink targets when linkable', () => {
    // The raw preview (escapes intact) should carry the hyperlink targets IF the
    // terminal supports OSC 8. In a non-TTY test env it degrades to plain text, so
    // we only assert the target is present when an escape was actually emitted.
    const raw = buildPreview(
      mk({ ticketId: 'RUSH-1864', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 }),
    );
    if (raw.includes('\x1b]8;;')) {
      expect(raw).toContain('https://linear.app/acme/issue/RUSH-1864');
      expect(raw).toContain('https://github.com/o/r/pull/42');
    } else {
      expect(stripVTControlCharacters(raw)).toContain('RUSH-1864');
    }
  });

  it('omits the links line entirely when the session has neither', () => {
    const preview = stripVTControlCharacters(buildPreview(mk({})));
    expect(preview).not.toContain('PR#');
    expect(preview).not.toContain('issue/');
  });
});
