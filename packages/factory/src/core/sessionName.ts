import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Claude Code persists a per-session metadata file containing
// { sessionId, name, ... } where `name` is the human-readable title shown
// by `/status`. We use it as the terminal tab label so the tab matches the
// agent's own title instead of a 5-word truncation of the user's first
// message.
//
// File locations:
//   - ~/.claude/sessions/<pid>.json                          (vanilla install)
//   - ~/.agents/.history/versions/claude/<ver>/home/.claude/sessions/<pid>.json
//     (agents-cli install — one dir per pinned CLI version; ~/.claude is a
//     symlink to a single version, so we have to scan all versions to
//     resolve a session running on a different pinned version than the
//     symlinked default).
//
// Codex/Gemini/Opencode do not persist an equivalent today — they fall
// through to the LLM-generated label path in extension.ts.

interface ClaudeSessionFile {
  sessionId?: string;
  name?: string | null;
}

interface ScanCache {
  builtAt: number;
  bySessionId: Map<string, string>; // only successful resolutions
}

const TTL_MS = 30_000;
let cache: ScanCache | null = null;

export interface ReadSessionNameOptions {
  sessionsDirs?: string[]; // override discovery (used by tests)
  now?: number;
}

export async function readClaudeSessionName(
  sessionId: string,
  options: ReadSessionNameOptions = {}
): Promise<string | null> {
  if (!sessionId) return null;

  const now = options.now ?? Date.now();
  const dirs = options.sessionsDirs ?? (await discoverSessionDirs());

  if (cache && now - cache.builtAt < TTL_MS) {
    return cache.bySessionId.get(sessionId) ?? null;
  }

  const rebuilt = await rebuildCache(dirs, now);
  cache = rebuilt;
  return rebuilt.bySessionId.get(sessionId) ?? null;
}

async function discoverSessionDirs(): Promise<string[]> {
  const home = os.homedir();
  const dirs = new Set<string>();
  dirs.add(path.join(home, '.claude', 'sessions'));

  // Walk ~/.agents/.history/versions/claude/<version>/home/.claude/sessions
  const versionsRoot = path.join(home, '.agents', '.history', 'versions', 'claude');
  try {
    const versions = await fs.promises.readdir(versionsRoot);
    for (const ver of versions) {
      dirs.add(path.join(versionsRoot, ver, 'home', '.claude', 'sessions'));
    }
  } catch {
    // agents-cli not installed — fine
  }

  return Array.from(dirs);
}

async function rebuildCache(dirs: string[], now: number): Promise<ScanCache> {
  const bySessionId = new Map<string, string>();

  await Promise.all(dirs.map((dir) => scanDir(dir, bySessionId)));

  return { builtAt: now, bySessionId };
}

async function scanDir(dir: string, sink: Map<string, string>): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const raw = await fs.promises.readFile(path.join(dir, f), 'utf-8');
          const parsed = JSON.parse(raw) as ClaudeSessionFile;
          if (parsed.sessionId && typeof parsed.name === 'string' && parsed.name.trim()) {
            sink.set(parsed.sessionId, parsed.name.trim());
          }
        } catch {
          // malformed or unreadable file — skip silently
        }
      })
  );
}

// Test-only: clear the in-memory cache between cases.
export function resetSessionNameCache(): void {
  cache = null;
}
