/**
 * Per-agent adapter for sync. Each supported agent declares where its
 * transcripts live and how to derive a session id and storage-relative key
 * from a file path. The merge (crdt.ts) and transport (r2.ts) are fully
 * agent-agnostic — adding a new agent is just another entry in SYNC_AGENTS.
 *
 * Mirror layout: synced-in transcripts land under
 *   ~/.agents/.history/backups/<agent>/<machine>/<subdir>/<relKey>
 * which is already a scan root (getAgentSessionDirs scans backups/<agent>/<ts>),
 * so the existing incremental scanner indexes them with no changes. Because the
 * scanner dedups by session id with the live home scanned first, a session that
 * also exists locally always wins — the mirror only ever fills in sessions
 * originated on other machines.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir } from '../../state.js';
import { getAgentSessionDirs } from '../discover.js';
import { walkForFiles } from '../../fs-walk.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface LocalTranscript {
  /** Absolute path on this machine. */
  absPath: string;
  /** Globally-unique session id (the grouping key across machines). */
  sessionId: string;
  /** Path relative to the agent's subdir root — preserved in the mirror layout. */
  relKey: string;
}

export interface SyncAgentSpec {
  id: string;
  /** Config subdir under the agent home that holds transcripts. */
  subdir: string;
  /** File extension to walk for this agent (defaults to .jsonl). */
  ext?: string;
  /** Derive the session id from a storage-relative key. */
  sessionIdFromRelKey(relKey: string): string;
}

export const SYNC_AGENTS: SyncAgentSpec[] = [
  {
    id: 'claude',
    subdir: 'projects',
    // Claude transcripts are <projectDir>/<sessionId>.jsonl.
    sessionIdFromRelKey: rel => path.basename(rel).replace(/\.jsonl$/, ''),
  },
  {
    id: 'codex',
    subdir: 'sessions',
    // Codex transcripts are rollout-<ts>-<uuid>.jsonl under date dirs; the uuid
    // is the session id (matches session_meta.payload.id).
    sessionIdFromRelKey: rel => path.basename(rel).match(UUID_RE)?.[0] ?? rel,
  },
  {
    id: 'droid',
    subdir: 'sessions',
    // Droid writes <uuid>.jsonl under per-cwd subdirs (plus an optional
    // <uuid>.settings.json sidecar for metadata). The JSONL is the canonical
    // transcript; the sidecar is rebuilt from the transcript on the mirror.
    sessionIdFromRelKey: rel => path.basename(rel).replace(/\.jsonl$/, ''),
  },
  {
    id: 'grok',
    subdir: 'sessions',
    // Grok sessions are multi-file directories under ~/.grok/sessions/<cwd>/<uuid>/.
    // events.jsonl is the canonical transcript stream; syncing it lets the mirror
    // reconstruct the session (summary.json metadata is recomputed on read).
    sessionIdFromRelKey: rel => path.basename(path.dirname(rel)),
  },
  {
    id: 'kimi',
    subdir: 'sessions',
    ext: '.json',
    // Kimi sessions are multi-file directories under
    // ~/.kimi-code/sessions/<wd_hash>/session_<uuid>/. state.json carries the
    // metadata the scanner reads; wire.jsonl (conversation) is a follow-up
    // tracked by the multi-file-sessions ticket.
    sessionIdFromRelKey: rel => {
      const m = rel.match(/session_[^/]+/);
      return m?.[0] ?? rel;
    },
  },
  {
    id: 'opencode',
    subdir: 'sessions',
    // OpenCode stores sessions in a single SQLite DB (~/.local/share/opencode/opencode.db)
    // rather than transcript files. This entry reserves the agent slot so the
    // sync matrix is complete; file-based round-tripping requires an SQLite-to-JSONL
    // export step (not yet implemented).
    sessionIdFromRelKey: rel => path.basename(rel),
  },
];

let cachedMirrorRoot: string | null = null;
function mirrorRootReal(): string {
  if (cachedMirrorRoot) return cachedMirrorRoot;
  const root = path.join(getHistoryDir(), 'backups');
  cachedMirrorRoot = safeReal(root);
  return cachedMirrorRoot;
}

function safeReal(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * List this machine's own transcript files for an agent, EXCLUDING the sync
 * mirror (we never re-upload another machine's files under our prefix). Dedups
 * by session id so a session present in multiple version homes is uploaded once.
 */
export function listLocalTranscripts(spec: SyncAgentSpec): LocalTranscript[] {
  const mirror = mirrorRootReal();
  const out: LocalTranscript[] = [];
  const seen = new Set<string>();

  for (const dir of getAgentSessionDirs(spec.id, spec.subdir)) {
    if (safeReal(dir).startsWith(mirror)) continue; // skip synced-in mirror dirs
    for (const abs of walkForFiles(dir, spec.ext ?? '.jsonl', 100_000)) {
      const relKey = path.relative(dir, abs);
      if (!relKey || relKey.startsWith('..')) continue;
      const sessionId = spec.sessionIdFromRelKey(relKey);
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      out.push({ absPath: abs, sessionId, relKey });
    }
  }
  return out;
}

/** Session ids this machine holds locally (live home), used to skip mirror writes. */
export function localSessionIds(spec: SyncAgentSpec): Set<string> {
  return new Set(listLocalTranscripts(spec).map(t => t.sessionId));
}

/** Absolute mirror path for a remote machine's transcript — lands in a scan root. */
export function mirrorPath(spec: SyncAgentSpec, machine: string, relKey: string): string {
  return path.join(getHistoryDir(), 'backups', spec.id, machine, spec.subdir, relKey);
}

/** R2 object key for a transcript: sessions/<machine>/<agent>/<sessionId>.jsonl */
export function objectKey(machine: string, agentId: string, sessionId: string): string {
  return `sessions/${machine}/${agentId}/${sessionId}.jsonl`;
}

/** R2 object key for a machine's manifest. */
export function manifestKey(machine: string): string {
  return `sessions/${machine}/manifest.json`;
}

/** Prefix under which all machine manifests live (for discovery). */
export const SESSIONS_PREFIX = 'sessions/';
