/**
 * Session forking — branch an existing conversation into a new, independent
 * session that can be continued separately, leaving the original untouched.
 *
 * `resume` continues the SAME conversation (same id, same file — it appends).
 * `fork` copies the transcript under a FRESH session id, so continuing the fork
 * diverges from the original instead of mutating it. This is the "git branch"
 * of conversations.
 *
 * v1 supports Claude, whose session id IS its `<id>.jsonl` filename and which
 * resumes natively via `--resume`. A fork is therefore: copy the transcript to
 * a new-uuid filename in the same directory, rewrite the embedded `sessionId`
 * on each line, register the new session in the index, and label it. Other
 * agents (codex single-file; grok/kimi multi-file; opencode DB-only) are a
 * natural follow-up and are refused up front for now.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { SessionMeta } from './types.js';
import { upsertSession } from './db.js';
import { recordRunName } from './run-names.js';

/** Agents that `fork` can branch today (see the module doc for why). */
export const FORKABLE_AGENTS = ['claude'] as const;

/** Whether a session's agent can be forked by {@link forkSession}. */
export function isForkableAgent(agent: string): boolean {
  return (FORKABLE_AGENTS as readonly string[]).includes(agent);
}

/** Outcome of a successful fork. */
export interface ForkResult {
  /** The new session's full id. */
  newId: string;
  /** The new session's short id (first 8 chars), for display/resume. */
  shortId: string;
  /** Absolute path of the copied transcript. */
  filePath: string;
  /** The label applied to the fork. */
  label: string;
}

/**
 * Rewrite the per-line `sessionId` field of a Claude JSONL transcript to a new
 * id. Claude resolves a conversation by its filename, so this is belt-and-braces
 * (keeps the in-file id consistent with the new filename); malformed lines are
 * passed through untouched.
 */
function rewriteSessionId(transcript: string, newId: string): string {
  return transcript
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.sessionId === 'string') {
          obj.sessionId = newId;
          return JSON.stringify(obj);
        }
        return line;
      } catch {
        return line;
      }
    })
    .join('\n');
}

/**
 * Fork a Claude session into a new, independent one.
 *
 * Copies `source.filePath` to a new `<uuid>.jsonl` beside it, rewrites the
 * embedded session id, registers the new session in the index, and records a
 * `--name`-style label. Returns the new ids/path. Throws if the source
 * transcript is missing.
 *
 * @param source  The resolved metadata of the session being forked.
 * @param opts.name  Optional explicit label; defaults to `fork of <original>`.
 * @param now  ISO timestamp to stamp the fork with (injectable for tests).
 */
export function forkSession(source: SessionMeta, opts: { name?: string; now?: string } = {}): ForkResult {
  if (!fs.existsSync(source.filePath)) {
    throw new Error(`transcript not found for session ${source.shortId}: ${source.filePath}`);
  }

  const newId = randomUUID();
  const shortId = newId.slice(0, 8);
  const dir = path.dirname(source.filePath);
  const filePath = path.join(dir, `${newId}.jsonl`);

  const transcript = fs.readFileSync(source.filePath, 'utf-8');
  const rewritten = rewriteSessionId(transcript, newId);
  fs.writeFileSync(filePath, rewritten);

  const original = source.label || source.topic || source.shortId;
  const label = opts.name || `fork of ${original}`;

  // Label sidecar (seeds the DB label; survives rescans until an agent title
  // supersedes it), mirroring `agents run --name`.
  recordRunName({ sessionId: newId, name: label, agent: source.agent, cwd: source.cwd });

  // Register the new session so it resolves immediately (by `agents resume`,
  // `agents sessions`, etc.) without waiting for the next scan.
  const stamp = opts.now ?? new Date().toISOString();
  const meta: SessionMeta = {
    ...source,
    id: newId,
    shortId,
    filePath,
    label,
    timestamp: stamp,
    lastActivity: stamp,
    // The fork has not opened its own PR / team; drop origin-specific refs.
    prUrl: undefined,
    prNumber: undefined,
    teamOrigin: undefined,
    spawnedTeam: undefined,
  };
  upsertSession(meta, rewritten);

  return { newId, shortId, filePath, label };
}
