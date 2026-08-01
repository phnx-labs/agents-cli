import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Claude Code persists a per-session metadata file containing
// { sessionId, name, nameSource, ... } where `name` is the title shown by
// `/status`. When the user (or Claude itself) has set a real title, we use it
// as the terminal tab label so the tab matches the agent's own title instead
// of a 5-word truncation of the user's first message.
//
// Claude 2.1.207+ ALSO auto-derives a placeholder name — `<dirname>-<n>`
// (e.g. "agents-cli-55"), tagged `nameSource: "derived"`. That placeholder is
// not a topic; surfacing it as the tab label tells you the repo, not what the
// agent is working on, and it short-circuits the LLM topic path in
// extension.ts (which produces "Fix Fleet Login"-style titles). So a derived
// name is treated as no name at all — the caller falls through to the LLM
// path. Only a genuine title (any nameSource other than "derived") is used.
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
  nameSource?: string | null;
}

// The session's current name plus where it came from. `derived` is Claude's
// auto-generated `<dirname>-<n>` placeholder (nameSource === 'derived'); any
// other source (a real /status title, or an old CLI with no nameSource) is a
// genuine name.
export interface ClaudeSessionNameInfo {
  name: string;
  nameSource: string | null;
  derived: boolean;
}

interface ScanCache {
  builtAt: number;
  bySessionId: Map<string, ClaudeSessionNameInfo>; // every named session, derived or not
}

const TTL_MS = 30_000;
let cache: ScanCache | null = null;

export interface ReadSessionNameOptions {
  sessionsDirs?: string[]; // override discovery (used by tests)
  now?: number;
}

// The genuine title for a session, or null when there is none OR the only name
// is Claude's derived placeholder. This is the label-worthy name — reuse it as
// the tab label; a null means "fall through to the LLM topic path".
export async function readClaudeSessionName(
  sessionId: string,
  options: ReadSessionNameOptions = {}
): Promise<string | null> {
  const info = await readClaudeSessionNameInfo(sessionId, options);
  if (!info || info.derived) return null;
  return info.name;
}

// The session's CURRENT name and its source, INCLUDING the derived placeholder.
// Callers use this to ask "is <label> exactly this session's derived name?" —
// e.g. to un-stick a tab whose label is the `<dirname>-<n>` placeholder.
export async function readClaudeSessionNameInfo(
  sessionId: string,
  options: ReadSessionNameOptions = {}
): Promise<ClaudeSessionNameInfo | null> {
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
  const bySessionId = new Map<string, ClaudeSessionNameInfo>();

  await Promise.all(dirs.map((dir) => scanDir(dir, bySessionId)));

  return { builtAt: now, bySessionId };
}

async function scanDir(dir: string, sink: Map<string, ClaudeSessionNameInfo>): Promise<void> {
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
          // Store EVERY named session — including Claude's derived `<dirname>-<n>`
          // placeholder. readClaudeSessionName filters `derived` out (so a tab
          // never labels with the repo name), while readClaudeSessionNameInfo
          // exposes it so a caller can recognize and un-stick a promoted
          // placeholder label.
          if (parsed.sessionId && typeof parsed.name === 'string' && parsed.name.trim()) {
            sink.set(parsed.sessionId, {
              name: parsed.name.trim(),
              nameSource: parsed.nameSource ?? null,
              derived: parsed.nameSource === 'derived',
            });
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
