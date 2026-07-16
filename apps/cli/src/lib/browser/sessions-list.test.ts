import { describe, it, expect } from 'vitest';
import { resolveArtifact, renderBrowserSessions, type ProfileArtifacts } from './sessions-list.js';

// Pure selection + rendering logic (no filesystem). The bug surface is the
// `--open` selector precedence (latest / exact / substring) and the per-kind
// counts in the human table.

const groups: ProfileArtifacts[] = [
  {
    profile: 'work',
    artifacts: [
      { kind: 'download', name: 'report.pdf', path: '/b/work/downloads/report.pdf', bytes: 800_000, mtimeMs: 3000 },
      { kind: 'screenshot', task: 't1', name: '2000.png', path: '/b/work/sessions/t1/2000.png', bytes: 64_000, mtimeMs: 2000 },
    ],
  },
  {
    profile: 'personal',
    artifacts: [
      { kind: 'recording', task: 't2', name: '1000.webm', path: '/b/personal/sessions/t2/1000.webm', bytes: 5_000_000, mtimeMs: 1000 },
    ],
  },
];

describe('resolveArtifact', () => {
  it("'latest' picks the newest across all profiles", () => {
    expect(resolveArtifact(groups, 'latest')).toBe('/b/work/downloads/report.pdf');
  });

  it('matches an exact filename before falling back to substring', () => {
    expect(resolveArtifact(groups, '2000.png')).toBe('/b/work/sessions/t1/2000.png');
  });

  it('matches on a filename substring', () => {
    expect(resolveArtifact(groups, 'webm')).toBe('/b/personal/sessions/t2/1000.webm');
  });

  it('returns null when nothing matches', () => {
    expect(resolveArtifact(groups, 'nope.gif')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveArtifact([], 'latest')).toBeNull();
  });
});

describe('renderBrowserSessions', () => {
  it('summarizes per-kind counts per profile', () => {
    const out = renderBrowserSessions(groups);
    expect(out).toContain('work  screenshots 1  pdfs 0  recordings 0  downloads 1');
    expect(out).toContain('personal  screenshots 0  pdfs 0  recordings 1  downloads 0');
  });

  it('handles the no-profiles case', () => {
    expect(renderBrowserSessions([])).toBe('No browser profiles found.');
  });
});
