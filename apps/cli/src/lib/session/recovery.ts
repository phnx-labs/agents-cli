import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, agentConfigDirName } from '../agents.js';
import { isSelfHost } from '../devices/self-host.js';
import { nativeResume } from '../exec.js';
import { machineId, normalizeHost } from '../machine-id.js';
import {
  collectRunCandidates,
  formatNoHealthyAccountError,
  pickBalancedCandidate,
  readinessFromCandidate,
  type RotateCandidate,
} from '../accounting/rotate.js';
import type { AgentId } from '../types.js';
import { getVersionHomePath } from '../installations/versions.js';
import type { SessionMeta } from './types.js';

export type SessionRecoveryTarget =
  | { mode: 'native'; agent: AgentId; version: string; cwd?: string; reason: string }
  | { mode: 'continue'; agent: AgentId; version: string; reason: string };

export type NativeResumeInspection =
  | { available: true; cwd?: string }
  | { available: false; reason: string };

export class SessionRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionRecoveryError';
  }
}

/** Canonical origin-device label for every recovery consumer. */
export function sessionOriginDevice(
  session: Pick<SessionMeta, 'machine'>,
  self = machineId(),
): string {
  return normalizeHost(session.machine ?? self);
}

/** The peer that must execute recovery, or undefined when this is the origin. */
export function sessionRecoveryPeer(
  session: Pick<SessionMeta, 'machine'>,
  selfCheck: (host: string) => boolean = isSelfHost,
): string | undefined {
  if (!session.machine || selfCheck(session.machine)) return undefined;
  return normalizeHost(session.machine);
}

/** Whether an explicit placement names the session's origin device. */
export function sessionRecoveryDestinationMatches(
  session: Pick<SessionMeta, 'machine'>,
  requestedHost: string,
  self = machineId(),
): boolean {
  const requested = normalizeHost(requestedHost.split('@').pop() || requestedHost);
  return requested === sessionOriginDevice(session, self);
}

function runnableSessionAgent(session: SessionMeta): AgentId {
  if (!(session.agent in AGENTS)) {
    throw new SessionRecoveryError(
      `Session ${session.shortId} belongs to ${session.agent}, which is indexed but cannot be launched by agents run.`,
    );
  }
  return session.agent as AgentId;
}

function sourceReason(session: SessionMeta, candidates: RotateCandidate[]): string {
  if (!session.version) return 'the origin version was not recorded';
  const source = candidates.find((candidate) => candidate.version === session.version);
  if (!source) return `origin ${session.agent}@${session.version} is not installed`;
  const readiness = readinessFromCandidate(source);
  return readiness.ready
    ? `origin ${session.agent}@${session.version} has no native resume form`
    : `origin ${session.agent}@${session.version} is ${readiness.reason}`;
}

function isPathInside(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function existingDirectory(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Read the launch cwd Claude used to choose its projects/<cwd-key> directory.
 * Claude can record attachment envelopes before the first user turn, and those
 * envelopes retain the actual launch cwd even after the session changes dirs. */
function readClaudeLaunchCwd(filePath: string): string | undefined {
  const maxBytes = 2 * 1024 * 1024;
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return undefined;
  }

  try {
    const chunk = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, chunk, 0, maxBytes, 0);
    const lines = chunk.toString('utf8', 0, bytesRead).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.cwd !== 'string' || !path.isAbsolute(parsed.cwd)) continue;
        if (existingDirectory(parsed.cwd)) return parsed.cwd;
      } catch {
        // A malformed line or vanished cwd cannot identify a usable native home.
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

/**
 * Prove that the indexed transcript is reachable from the exact active version
 * home that would receive native resume. Retained trash/backup transcripts are
 * intentionally rejected here: they remain readable by `/continue`, but a new
 * installation with the same version number must not native-resume an empty
 * isolated home.
 */
export function inspectNativeResumeSession(
  session: SessionMeta,
  versionHome: string,
): NativeResumeInspection {
  let realFile: string;
  try {
    realFile = fs.realpathSync(session.filePath);
  } catch {
    return { available: false, reason: 'the indexed transcript is no longer present in the origin home' };
  }

  const roots = [versionHome, path.join(versionHome, agentConfigDirName(session.agent as AgentId))];
  const owned = roots.some((root) => {
    try {
      return isPathInside(realFile, fs.realpathSync(root));
    } catch {
      return false;
    }
  });
  if (!owned) {
    return {
      available: false,
      reason: `the indexed transcript is retained outside the active ${session.agent}@${session.version ?? 'unknown'} home`,
    };
  }

  if (session.agent === 'claude') {
    const cwd = readClaudeLaunchCwd(realFile);
    if (!cwd) {
      return {
        available: false,
        reason: 'the Claude transcript does not identify an existing original project directory',
      };
    }
    return { available: true, cwd };
  }

  const cwd = existingDirectory(session.cwd);
  return { available: true, cwd };
}

/**
 * Decide how a durable session resumes on the device that owns it.
 *
 * Native resume is legal only in the exact origin version's isolated home and
 * only while that account is healthy. Every other successful path stays on the
 * same harness and uses `/continue`, whose indexed transcript reader can reach
 * retained version trash. No healthy same-harness account is a loud failure.
 */
export function resolveSessionRecoveryFromCandidates(
  session: SessionMeta,
  candidates: RotateCandidate[],
  supportsNative: (agent: AgentId, version?: string) => boolean = nativeResume,
  nativeInspection?: NativeResumeInspection,
): SessionRecoveryTarget {
  const agent = runnableSessionAgent(session);
  const device = sessionOriginDevice(session);
  const source = session.version
    ? candidates.find((candidate) => candidate.version === session.version)
    : undefined;
  const sourceReady = source ? readinessFromCandidate(source).ready : false;

  // An exact healthy origin is deterministic: preserve its isolated home. If
  // native resume is unavailable for that harness, /continue still launches in
  // that same healthy home. Only an unusable/missing origin enters balanced
  // account selection.
  const selection = sourceReady
    ? { picked: source! }
    : pickBalancedCandidate(candidates);
  if (!selection) {
    const detail = formatNoHealthyAccountError(agent, 'balanced', candidates);
    throw new SessionRecoveryError(
      `Cannot recover session ${session.shortId} on ${device}; origin ${agent}@${session.version ?? 'unknown'}. ${detail}`,
    );
  }

  const version = selection.picked.version;
  if (session.version === version && supportsNative(agent, version)) {
    const inspection = nativeInspection
      ?? inspectNativeResumeSession(session, getVersionHomePath(agent, version));
    if (inspection.available) {
      return {
        mode: 'native',
        agent,
        version,
        cwd: inspection.cwd,
        reason: `origin ${agent}@${version} is installed, healthy, and owns the indexed transcript`,
      };
    }
    return {
      mode: 'continue',
      agent,
      version,
      reason: `${inspection.reason}; continuing with healthy ${agent}@${version}`,
    };
  }

  return {
    mode: 'continue',
    agent,
    version,
    reason: `${sourceReason(session, candidates)}; continuing with healthy ${agent}@${version}`,
  };
}

export async function resolveSessionRecovery(session: SessionMeta): Promise<SessionRecoveryTarget> {
  const agent = runnableSessionAgent(session);
  return resolveSessionRecoveryFromCandidates(session, await collectRunCandidates(agent));
}

/** Stable self-command used by focus, resume, and attach. The owning device runs
 * the recovery resolver above; callers must not native-resume another version's
 * isolated home themselves. */
export function sessionRecoveryRunArgs(session: Pick<SessionMeta, 'id'>): string[] {
  return ['run', 'auto', '--resume', session.id, '--interactive'];
}
