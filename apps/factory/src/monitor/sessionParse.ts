// Pure session-file parsing + root resolution (vscode-free).
//
// The machine-wide session watcher (#69) runs in the monitor (a plain process,
// no vscode) and must parse the same head metadata `sessionTracker` reads today
// so a follower can run the identical correlation against its own terminals.
// To keep one source of truth, the parser and the session-root helpers live
// here and BOTH the leader-side watcher and the window-local `sessionTracker`
// import them.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { createHash } from 'crypto';
import { SessionAgentKind } from './protocol';
import { runAgents } from '../core/agentsBin';

const LINE_CAP = 100;

export interface ParseResult {
  forkedFromId?: string;
  codexCwd?: string;
  geminiProjectHash?: string;
  geminiSessionId?: string;
  opencodeDirectory?: string;
  opencodeSessionId?: string;
}

function homeDir(): string {
  return os.homedir();
}

export function sessionIdFromFile(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '');
}

export function workspaceHash(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex');
}

/**
 * Read the head of a session file and extract the correlation metadata. JSON
 * agents (gemini/opencode) read the whole file; JSONL agents (claude/codex)
 * scan up to LINE_CAP lines for the first relevant record.
 */
export async function parseSessionHead(
  file: string,
  agentType: SessionAgentKind,
): Promise<ParseResult> {
  const result: ParseResult = {};
  if (agentType === 'gemini' || agentType === 'opencode') {
    try {
      const raw = await fs.promises.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      if (agentType === 'gemini') {
        if (typeof parsed?.projectHash === 'string') {
          result.geminiProjectHash = parsed.projectHash;
        }
        if (typeof parsed?.sessionId === 'string') {
          result.geminiSessionId = parsed.sessionId;
        }
      } else {
        if (typeof parsed?.directory === 'string') {
          result.opencodeDirectory = parsed.directory;
        }
        if (typeof parsed?.id === 'string') {
          result.opencodeSessionId = parsed.id;
        }
      }
    } catch {
      /* ignore malformed json */
    }
    return result;
  }

  let stream: fs.ReadStream | undefined;
  let rl: readline.Interface | undefined;
  let count = 0;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf-8' });
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (++count > LINE_CAP) break;
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (agentType === 'claude') {
        const forked = parsed?.forkedFrom?.sessionId;
        if (typeof forked === 'string' && forked.length > 0) {
          result.forkedFromId = forked;
          break;
        }
      } else {
        if (parsed?.type === 'session_meta') {
          const cwd = parsed?.payload?.cwd;
          if (typeof cwd === 'string') result.codexCwd = cwd;
          break;
        }
        if (parsed?.payload?.cwd && typeof parsed.payload.cwd === 'string') {
          result.codexCwd = parsed.payload.cwd;
          break;
        }
      }
    }
  } catch {
    /* ignore transient read errors (deleted/rotated files) */
  } finally {
    rl?.close();
    stream?.destroy();
  }
  return result;
}

// --- Session roots (machine-wide, not workspace-keyed) --------------------

export type AgentRootKind = SessionAgentKind | 'cursor';

let cachedClaudeRoots: string[] | undefined;

/** ~/.claude/projects plus every installed version's projects dir (cached). */
export function claudeProjectRoots(): string[] {
  if (cachedClaudeRoots) return cachedClaudeRoots;
  const home = homeDir();
  const roots = [path.join(home, '.claude', 'projects')];
  const versionsDir = path.join(home, '.agents', '.history', 'versions', 'claude');
  if (fs.existsSync(versionsDir)) {
    try {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        roots.push(path.join(versionsDir, entry.name, 'home', '.claude', 'projects'));
      }
    } catch {
      /* ignore */
    }
  }
  cachedClaudeRoots = roots;
  return roots;
}

/** The top-level session roots for an agent (used by fast-path + locate). */
export function agentSessionRoots(agentKey: AgentRootKind): string[] {
  const home = homeDir();
  switch (agentKey) {
    case 'claude':
      return claudeProjectRoots();
    case 'codex':
      return [path.join(home, '.codex', 'sessions')];
    case 'gemini':
      return [path.join(home, '.gemini', 'tmp')];
    case 'opencode':
      return [path.join(home, '.local', 'share', 'opencode', 'storage', 'message')];
    case 'cursor':
      return [path.join(home, '.cursor', 'chats')];
  }
}

export interface WatcherRoot {
  root: string;
  agentType: SessionAgentKind;
}

/**
 * The set of roots the machine-wide watcher recursively watches — one entry
 * per (root, agentType). The watcher mounts exactly one fs.watch per root.
 * This is the degraded path for a machine without agents-cli; the watcher
 * normally configures itself from watcherRootsFromCli() below.
 */
export function watcherRoots(): WatcherRoot[] {
  const home = homeDir();
  const roots: WatcherRoot[] = [];
  for (const root of claudeProjectRoots()) roots.push({ root, agentType: 'claude' });
  roots.push({ root: path.join(home, '.codex', 'sessions'), agentType: 'codex' });
  roots.push({ root: path.join(home, '.gemini', 'tmp'), agentType: 'gemini' });
  roots.push({
    root: path.join(home, '.local', 'share', 'opencode', 'storage', 'session'),
    agentType: 'opencode',
  });
  return roots;
}

/** One `agents sessions --roots --json` entry (the CLI's SessionRoots shape). */
interface CliSessionRootsEntry {
  agent?: string;
  dirs?: unknown[];
}

/**
 * Watcher roots from the CLI's own discovery table (`agents sessions --roots
 * --json`, issue #741) — the exact directories `agents sessions` scans, so the
 * watcher stays in lockstep when an agent's on-disk layout changes (the
 * hardcoded list kept watching ~/.gemini/sessions after gemini moved its
 * transcripts to ~/.gemini/tmp). Roots for agents whose transcripts this
 * monitor cannot parse (antigravity, droid, kimi) are skipped. OpenCode is
 * appended from the local default: the CLI does not scan opencode transcripts,
 * so it never appears in --roots. Falls back to watcherRoots() when the CLI is
 * missing or the payload is unusable.
 */
export async function watcherRootsFromCli(): Promise<WatcherRoot[]> {
  let stdout: string;
  try {
    ({ stdout } = await runAgents('sessions --roots --json', { timeout: 15_000 }));
  } catch {
    return watcherRoots();
  }
  let entries: CliSessionRootsEntry[];
  try {
    const parsed = JSON.parse(stdout);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    return watcherRoots();
  }
  const roots: WatcherRoot[] = [];
  for (const entry of entries) {
    const agent = entry?.agent;
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'gemini') continue;
    for (const dir of entry.dirs ?? []) {
      if (typeof dir === 'string' && dir) roots.push({ root: dir, agentType: agent });
    }
  }
  if (roots.length === 0) return watcherRoots();
  roots.push({
    root: path.join(homeDir(), '.local', 'share', 'opencode', 'storage', 'session'),
    agentType: 'opencode',
  });
  return roots;
}

/** Filename filter mirroring sessionTracker.onRename: jsonl for claude/codex, json otherwise. */
export function isSessionFilename(filename: string, agentType: SessionAgentKind): boolean {
  const isJsonl = agentType === 'claude' || agentType === 'codex';
  return isJsonl ? filename.endsWith('.jsonl') : filename.endsWith('.json');
}

export function __clearRootCacheForTests(): void {
  cachedClaudeRoots = undefined;
}
