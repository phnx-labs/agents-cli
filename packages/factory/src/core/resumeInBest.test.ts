import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  pickBestVersion,
  sessionUsedPercent,
  inlineContinueInstructions,
  buildLaunchCommand,
  buildResumeInput,
  isVersionStillUsable,
  AgentsViewJsonAgent,
  AgentsViewJsonVersion,
} from './resumeInBest';

// Real fixture captured from `agents view claude --json` on 2026-04-22.
// Has 10 Claude versions, mixed states: rate_limited + out_of_credits across
// 5 accounts, plus 3 not-signed-in entries. Also present: default flag on
// 2.1.112 at 19% session, and 2.1.111 at 0% session on a different account.
const FIXTURE_PATH = path.join(__dirname, 'testdata', 'view-claude.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as AgentsViewJsonAgent;

function makeVersion(overrides: Partial<AgentsViewJsonVersion> = {}): AgentsViewJsonVersion {
  return {
    version: '2.1.112',
    isDefault: false,
    signedIn: true,
    email: 'user@example.com',
    plan: 'Max',
    usageStatus: 'rate_limited',
    windows: [
      { key: 'session', usedPercent: 10, resetsAt: '2026-04-22T18:00:00Z' },
      { key: 'week', usedPercent: 40, resetsAt: '2026-04-28T18:00:00Z' },
    ],
    lastActive: '2026-04-22T12:00:00Z',
    path: '/home/user/.agents/versions/claude/2.1.112',
    ...overrides,
  };
}

describe('pickBestVersion — real fixture', () => {
  test('fixture has the expected shape', () => {
    expect(fixture.agent).toBe('claude');
    expect(fixture.versions.length).toBeGreaterThan(5);
    expect(fixture.versions.some(v => v.isDefault)).toBe(true);
    expect(fixture.versions.some(v => !v.signedIn)).toBe(true);
    expect(fixture.versions.some(v => v.usageStatus === 'out_of_credits')).toBe(true);
  });

  test('picks the signed-in, not-out-of-credits version with lowest session%', () => {
    const picked = pickBestVersion(fixture.versions);
    expect(picked).not.toBeNull();
    expect(picked!.signedIn).toBe(true);
    expect(picked!.usageStatus).not.toBe('out_of_credits');

    // Every other usable candidate must have session% >= picked's session%.
    const usable = fixture.versions.filter(
      v => v.signedIn && v.usageStatus !== 'out_of_credits'
    );
    for (const v of usable) {
      expect(sessionUsedPercent(v)).toBeGreaterThanOrEqual(sessionUsedPercent(picked!));
    }
  });

  test('does NOT pick the default if a better candidate exists', () => {
    const def = fixture.versions.find(v => v.isDefault)!;
    const picked = pickBestVersion(fixture.versions);
    if (sessionUsedPercent(def) > sessionUsedPercent(picked!)) {
      expect(picked!.version).not.toBe(def.version);
    }
  });
});

describe('pickBestVersion — synthetic cases', () => {
  test('returns null when no versions are signed in', () => {
    const versions = [
      makeVersion({ signedIn: false, email: null }),
      makeVersion({ signedIn: false, email: null, version: '2.1.100' }),
    ];
    expect(pickBestVersion(versions)).toBeNull();
  });

  test('returns null on empty input', () => {
    expect(pickBestVersion([])).toBeNull();
  });

  test('prefers lower session% even when higher% has usageStatus=available', () => {
    const versions = [
      makeVersion({ version: 'A', usageStatus: 'available', windows: [{ key: 'session', usedPercent: 80, resetsAt: null }] }),
      makeVersion({ version: 'B', usageStatus: 'rate_limited', windows: [{ key: 'session', usedPercent: 0, resetsAt: null }] }),
    ];
    expect(pickBestVersion(versions)!.version).toBe('B');
  });

  test('breaks ties on session% using usageStatus (available > rate_limited)', () => {
    const versions = [
      makeVersion({ version: 'A', usageStatus: 'rate_limited', windows: [{ key: 'session', usedPercent: 0, resetsAt: null }] }),
      makeVersion({ version: 'B', usageStatus: 'available',    windows: [{ key: 'session', usedPercent: 0, resetsAt: null }] }),
    ];
    expect(pickBestVersion(versions)!.version).toBe('B');
  });

  test('breaks further ties using lastActive (more recent wins)', () => {
    const versions = [
      makeVersion({ version: 'older', lastActive: '2026-04-20T10:00:00Z', windows: [{ key: 'session', usedPercent: 0, resetsAt: null }] }),
      makeVersion({ version: 'newer', lastActive: '2026-04-22T10:00:00Z', windows: [{ key: 'session', usedPercent: 0, resetsAt: null }] }),
    ];
    expect(pickBestVersion(versions)!.version).toBe('newer');
  });

  test('falls back to out_of_credits when every signed-in version is out_of_credits', () => {
    const versions = [
      makeVersion({ version: 'X', usageStatus: 'out_of_credits', windows: [{ key: 'session', usedPercent: 50, resetsAt: null }] }),
      makeVersion({ version: 'Y', usageStatus: 'out_of_credits', windows: [{ key: 'session', usedPercent: 10, resetsAt: null }] }),
    ];
    const picked = pickBestVersion(versions);
    expect(picked).not.toBeNull();
    expect(picked!.version).toBe('Y'); // lowest session%
  });

  test('ignores not-signed-in entries even if they have 0% session', () => {
    const versions = [
      makeVersion({ version: 'fresh', signedIn: false, email: null, windows: [{ key: 'session', usedPercent: 0, resetsAt: null }] }),
      makeVersion({ version: 'used', signedIn: true, windows: [{ key: 'session', usedPercent: 30, resetsAt: null }] }),
    ];
    expect(pickBestVersion(versions)!.version).toBe('used');
  });

  test('treats missing session window as 100% (worst case)', () => {
    const versions = [
      makeVersion({ version: 'no-session', windows: [{ key: 'week', usedPercent: 5, resetsAt: null }] }),
      makeVersion({ version: 'has-session', windows: [{ key: 'session', usedPercent: 50, resetsAt: null }] }),
    ];
    expect(pickBestVersion(versions)!.version).toBe('has-session');
  });
});

describe('inlineContinueInstructions', () => {
  const REAL_CONTINUE_MD = `---
description: Resume a previous task - load context via agents sessions, assess state, then continue working
---

Resume previous work: $ARGUMENTS

You are picking up where a previous session left off.

## Step 1: Load the prior session

Run \`agents sessions $ARGUMENTS\` to load the transcript.`;

  test('strips YAML frontmatter', () => {
    const out = inlineContinueInstructions(REAL_CONTINUE_MD, 'abc123');
    expect(out).not.toContain('description:');
    expect(out).not.toMatch(/^---/);
    expect(out.startsWith('Resume previous work:')).toBe(true);
  });

  test('substitutes $ARGUMENTS with session id everywhere', () => {
    const out = inlineContinueInstructions(REAL_CONTINUE_MD, 'abc123');
    expect(out).not.toContain('$ARGUMENTS');
    expect(out).toContain('Resume previous work: abc123');
    expect(out).toContain('agents sessions abc123');
  });

  test('handles body without frontmatter', () => {
    const out = inlineContinueInstructions('Just content with $ARGUMENTS', 'xyz');
    expect(out).toBe('Just content with xyz');
  });

  test('handles empty session id', () => {
    const out = inlineContinueInstructions('Run with $ARGUMENTS here.', '');
    expect(out).toBe('Run with  here.');
  });
});

describe('buildLaunchCommand', () => {
  test('claude gets --session-id with the new uuid', () => {
    const cmd = buildLaunchCommand('claude', '2.1.111', 'claude', 'abc-123');
    expect(cmd).toBe('claude@2.1.111 --session-id abc-123');
  });

  test('claude without a new session id omits the flag', () => {
    const cmd = buildLaunchCommand('claude', '2.1.111', 'claude', null);
    expect(cmd).toBe('claude@2.1.111');
  });

  test('codex does NOT get --session-id even if one is passed', () => {
    const cmd = buildLaunchCommand('codex', '0.116.0', 'codex', 'abc-123');
    expect(cmd).toBe('codex@0.116.0');
  });

  test('gemini, cursor, opencode similarly skip the flag', () => {
    expect(buildLaunchCommand('gemini', '1.0', 'gemini', 'x')).toBe('gemini@1.0');
    expect(buildLaunchCommand('cursor-agent', '2.0', 'cursor', 'x')).toBe('cursor-agent@2.0');
    expect(buildLaunchCommand('opencode', '3.0', 'opencode', 'x')).toBe('opencode@3.0');
  });
});

describe('buildResumeInput', () => {
  test('uses /continue when the slash command is synced', () => {
    const input = buildResumeInput('old-abc', true, null);
    expect(input).toBe('/continue old-abc');
  });

  test('inlines continue.md body when slash command is missing', () => {
    const md = `---\ndescription: test\n---\n\nResume work: $ARGUMENTS`;
    const input = buildResumeInput('old-xyz', false, md);
    expect(input).toContain('Resume work: old-xyz');
    expect(input).not.toContain('$ARGUMENTS');
    expect(input).not.toContain('description:');
  });

  test('falls back to terse instructions when continue.md cannot be read', () => {
    const input = buildResumeInput('old-fallback', false, null);
    expect(input).toContain('old-fallback');
    expect(input).toContain('agents sessions old-fallback');
  });

  test('always uses the OLD session id, never a new one', () => {
    // This is a regression guard — the new session id is for the fresh
    // claude process's container; /continue must load the OLD transcript.
    const input = buildResumeInput('OLD-ID', true, null);
    expect(input).toBe('/continue OLD-ID');
    expect(input).not.toContain('NEW');
  });
});

describe('isVersionStillUsable', () => {
  test('returns false for undefined/null (unknown version stays on legacy path)', () => {
    expect(isVersionStillUsable(undefined)).toBe(false);
    expect(isVersionStillUsable(null)).toBe(false);
  });

  test('returns false when the version is not signed in', () => {
    const v = makeVersion({
      signedIn: false,
      email: null,
      usageStatus: 'available',
      windows: [{ key: 'session', usedPercent: 0, resetsAt: null }],
    });
    expect(isVersionStillUsable(v)).toBe(false);
  });

  test('returns false when the version is out_of_credits', () => {
    const v = makeVersion({
      usageStatus: 'out_of_credits',
      windows: [{ key: 'session', usedPercent: 10, resetsAt: null }],
    });
    expect(isVersionStillUsable(v)).toBe(false);
  });

  test('returns false when session usage is at 100%', () => {
    const v = makeVersion({
      usageStatus: 'rate_limited',
      windows: [{ key: 'session', usedPercent: 100, resetsAt: null }],
    });
    expect(isVersionStillUsable(v)).toBe(false);
  });

  test('returns true for available version with room', () => {
    const v = makeVersion({
      usageStatus: 'available',
      windows: [{ key: 'session', usedPercent: 42, resetsAt: null }],
    });
    expect(isVersionStillUsable(v)).toBe(true);
  });

  test('returns true for rate_limited version with session room', () => {
    // rate_limited means the 5-hour window is tight but not spent — still
    // usable per our rule ("any version with usage is good enough").
    const v = makeVersion({
      usageStatus: 'rate_limited',
      windows: [{ key: 'session', usedPercent: 85, resetsAt: null }],
    });
    expect(isVersionStillUsable(v)).toBe(true);
  });

  test('returns false when session window is missing (treated as 100%)', () => {
    const v = makeVersion({
      usageStatus: 'available',
      windows: [{ key: 'week', usedPercent: 5, resetsAt: null }],
    });
    expect(isVersionStillUsable(v)).toBe(false);
  });
});

describe('sessionUsedPercent', () => {
  test('returns the session window percent', () => {
    expect(sessionUsedPercent(makeVersion({
      windows: [{ key: 'session', usedPercent: 42, resetsAt: null }]
    }))).toBe(42);
  });

  test('returns 100 when session window is missing', () => {
    expect(sessionUsedPercent(makeVersion({
      windows: [{ key: 'week', usedPercent: 5, resetsAt: null }]
    }))).toBe(100);
  });
});
