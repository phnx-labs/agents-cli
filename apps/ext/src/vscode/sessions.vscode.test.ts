import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearSessionPathCache, getClaudeProjectRoots, getSessionPathBySessionId } from './sessions.vscode';

async function withTempHome(run: (home: string) => Promise<void> | void): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmify-sessions-home-'));
  try {
    await run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Write an empty transcript for `sessionId` under `home` and return its path. */
function writeTranscript(home: string, projectDir: string, sessionId: string, root = '.claude'): string {
  const filePath = path.join(home, root, 'projects', projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"type":"message"}\n');
  return filePath;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Long enough to clear the resolver's miss-authority window, so a change made
// on disk after an index was built is visible to the next lookup.
const CACHE_SETTLE_MS = 600;

beforeEach(() => {
  // The resolver memoises across calls; without this each test would inherit
  // the previous test's index and assert against the wrong home.
  clearSessionPathCache();
});

describe('getSessionPathBySessionId', () => {
  test('includes .agents-system Claude version roots', async () => {
    await withTempHome(async (home) => {
      const projectRoot = path.join(
        home,
        '.agents-system',
        'versions',
        'claude',
        '2.1.121',
        'home',
        '.claude',
        'projects',
      );
      fs.mkdirSync(projectRoot, { recursive: true });

      const roots = await getClaudeProjectRoots(home);
      expect(roots).toContain(projectRoot);
    });
  });

  test('finds Claude sessions under .agents-system version homes', async () => {
    await withTempHome(async (home) => {
      const sessionId = '12345678-1234-1234-1234-123456789abc';
      const filePath = path.join(
        home,
        '.agents-system',
        'versions',
        'claude',
        '2.1.121',
        'home',
        '.claude',
        'projects',
        'repo',
        `${sessionId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{"type":"message"}\n');

      expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBe(filePath);
    });
  });

  // The resolver caches a filename index and each resolved path so the floor
  // rebuild stops issuing O(agents x projectDirs) stat calls. Each case below
  // pins one clause of that caching that would otherwise fail silently.
  describe('caching', () => {
    test('re-resolves after a cached transcript is moved to another project dir', async () => {
      await withTempHome(async (home) => {
        const sessionId = '11111111-1111-1111-1111-111111111111';
        const first = writeTranscript(home, 'repo-a', sessionId);
        expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBe(first);

        // Serving the cached path unconditionally would return the deleted file.
        fs.rmSync(first);
        const moved = writeTranscript(home, 'repo-b', sessionId);
        await sleep(CACHE_SETTLE_MS);

        expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBe(moved);
      });
    });

    test('returns undefined once a cached transcript is deleted outright', async () => {
      await withTempHome(async (home) => {
        const sessionId = '22222222-2222-2222-2222-222222222222';
        const filePath = writeTranscript(home, 'repo-a', sessionId);
        expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBe(filePath);

        fs.rmSync(filePath);
        await sleep(CACHE_SETTLE_MS);

        expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBeUndefined();
      });
    });

    test('finds a session created after the index was built', async () => {
      await withTempHome(async (home) => {
        const sessionId = '33333333-3333-3333-3333-333333333333';
        // Build the index while the transcript does not exist yet. A miss must
        // not be cached, and the index must not stay authoritative forever.
        fs.mkdirSync(path.join(home, '.claude', 'projects', 'repo-a'), { recursive: true });
        expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBeUndefined();

        const filePath = writeTranscript(home, 'repo-a', sessionId);
        await sleep(CACHE_SETTLE_MS);

        expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBe(filePath);
      });
    });

    test('keeps the pre-cache search order when the same id exists in two roots', async () => {
      await withTempHome(async (home) => {
        const sessionId = '44444444-4444-4444-4444-444444444444';
        // getClaudeProjectRoots yields ~/.claude/projects first, so the
        // sequential walk returned that copy; the index must agree.
        const versionRoot = path.join('.agents-system', 'versions', 'claude', '2.1.121', 'home', '.claude');
        writeTranscript(home, 'repo-a', sessionId, versionRoot);
        const preferred = writeTranscript(home, 'repo-a', sessionId);

        const roots = await getClaudeProjectRoots(home);
        expect(roots.indexOf(path.join(home, '.claude', 'projects'))).toBe(0);
        expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBe(preferred);
      });
    });

    test('resolves a second session in the same home without re-listing', async () => {
      await withTempHome(async (home) => {
        const a = '55555555-5555-5555-5555-555555555555';
        const b = '66666666-6666-6666-6666-666666666666';
        const pathA = writeTranscript(home, 'repo-a', a);
        const pathB = writeTranscript(home, 'repo-b', b);

        expect(await getSessionPathBySessionId(a, 'claude', undefined, home)).toBe(pathA);
        expect(await getSessionPathBySessionId(b, 'claude', undefined, home)).toBe(pathB);
      });
    });
  });
});
