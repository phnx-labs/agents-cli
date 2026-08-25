/**
 * Harness-level loop checkpoint (issue #332).
 *
 * A checkpoint is the durable harness state for a `--loop` run: it records the
 * iteration count, the pinned session id, the prompt being re-injected, and the
 * loop config — everything `--resume-checkpoint` needs to continue a run that a
 * SIGTERM, timeout, or machine sleep killed mid-flight.
 *
 * This is NOT provider-side state. `--session-id` resumes Claude's *conversation*
 * (server-side); a checkpoint resumes the *harness* (iteration count, loop
 * variables, prompt chain) — the part Claude's own resume cannot recover.
 *
 * Atomic write (temp + rename) mirrors `writeRunMeta` in routines.ts so a crash
 * mid-write never leaves a half-written checkpoint that `readCheckpoint` would
 * choke on. `readCheckpoint` returns null on a missing or corrupt file (mirrors
 * `readRunMeta`) — a corrupt checkpoint is a "start fresh", never a throw.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { getRunsDir } from './state.js';
import type { LoopConfig, LoopSignal } from './loop.js';

/** Durable harness state for a looped run, serialized to checkpoint.json. */
export interface Checkpoint {
  /** runId == the run directory name under getRunsDir(). */
  id: string;
  agent: AgentId;
  version?: string;
  /** The prompt re-injected each iteration. */
  prompt?: string;
  /** Pinned Claude session id so a resume continues the same conversation. */
  sessionId?: string;
  /** Iterations COMPLETED so far. A resume starts at iteration + 1. */
  iteration: number;
  /** The loop config governing termination. */
  loop: LoopConfig;
  /** Last loop-signal read, if any (for audit / resume context). */
  loopSignal?: LoopSignal;
  /** Cumulative tokens consumed across all iterations so far. */
  cumulativeTokens?: number;
  createdAt: string;
  updatedAt: string;
}

/** Path to a run's checkpoint file: <runsDir>/<runId>/checkpoint.json. */
export function checkpointPath(runId: string): string {
  return path.join(getRunsDir(), runId, 'checkpoint.json');
}

/**
 * Write a checkpoint atomically (temp file + rename). The rename is atomic on a
 * single filesystem, so a reader never observes a partially written file.
 * Mirrors the durable-write contract of `writeRunMeta`.
 */
export function writeCheckpoint(c: Checkpoint, file?: string): void {
  const target = file ?? checkpointPath(c.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

/**
 * Read a checkpoint from disk. Returns null if the file is missing or its
 * contents are not valid JSON — corruption means "no resumable state", which
 * the caller treats as a fresh start. Mirrors `readRunMeta`.
 */
export function readCheckpoint(file: string): Checkpoint | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || typeof parsed.iteration !== 'number') return null;
    return parsed as Checkpoint;
  } catch {
    return null;
  }
}
