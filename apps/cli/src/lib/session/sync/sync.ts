/**
 * Cross-machine session sync orchestration.
 *
 *  PUSH  this machine's transcripts (changed since last tick) to its own R2
 *        prefix, then publish a manifest. Single-writer prefixes mean no two
 *        machines ever write the same object — zero remote contention.
 *
 *  PULL  every other machine's manifest, fetch changed transcripts, CRDT-union
 *        copies of the same session, and write the result into the local mirror
 *        (a scan root). The existing scanner indexes it; sessions present in the
 *        live home always win, so the mirror only fills in remote-origin sessions.
 *
 * Invariants:
 *  - Live home transcripts are only ever READ + uploaded, never rewritten.
 *  - Union is idempotent, so once sets match nothing is transferred (quiescence).
 */

import * as fs from 'fs';
import * as path from 'path';
import { R2Client } from './r2.js';
import { loadR2Config, machineId } from './config.js';
import {
  SYNC_AGENTS,
  listLocalTranscripts,
  localSessionIds,
  mirrorPath,
  objectKey,
  manifestKey,
  SESSIONS_PREFIX,
  type SyncAgentSpec,
} from './agents.js';
import { mergeTranscripts, transcriptStats } from './crdt.js';
import { resolveSyncEncKey, encryptTranscript, decryptTranscriptBody } from './transcript-crypto.js';
import {
  emptyManifest,
  parseManifest,
  hashContent,
  loadLedger,
  saveLedger,
  ledgerUnchanged,
  ledgerRecord,
  loadLocalManifest,
  saveLocalManifest,
  loadPullState,
  savePullState,
  sourceSignature,
  type Manifest,
  type ManifestEntry,
  type PullState,
} from './manifest.js';

export interface SyncResult {
  machine: string;
  pushed: number;
  pushSkipped: number;
  pulled: number;
  merged: number;
  pullSkipped: number;
  errors: string[];
  /** Non-fatal advisories (e.g. transcripts uploaded unencrypted). Unlike
   *  `errors` these do not set a failing exit code. */
  warnings: string[];
}

export interface SyncOptions {
  verbose?: boolean;
  log?: (msg: string) => void;
  /** Upload this machine's transcripts (default true). */
  push?: boolean;
  /** Download + merge other machines' transcripts (default true). A machine
   *  with read-only R2 credentials can still pull. */
  pull?: boolean;
}

const nowIso = (): string => new Date().toISOString();

function specById(id: string): SyncAgentSpec | undefined {
  return SYNC_AGENTS.find(s => s.id === id);
}

/** Upload this machine's changed transcripts and publish its manifest. */
async function pushOwn(r2: R2Client, me: string, encKey: Buffer | null, opts: SyncOptions, result: SyncResult): Promise<void> {
  const ledger = loadLedger();
  const prev = loadLocalManifest();
  const manifest: Manifest = emptyManifest(me, nowIso());

  // The transcript body is sealed client-side before it leaves the machine
  // (AES-256-GCM under the shared bundle key). Without a key we still upload —
  // the feature predates encryption — but flag it LOUDLY once per cycle so an
  // unencrypted upload never happens silently.
  if (!encKey) {
    result.warnings.push(
      `R2_SYNC_ENC_KEY not set in the r2.backups bundle — transcripts are uploaded UNENCRYPTED ` +
      `(readable by anyone with bucket access). Add the shared key to enable client-side encryption.`,
    );
  }

  for (const spec of SYNC_AGENTS) {
    const agentManifest: Record<string, ManifestEntry> = {};
    for (const t of listLocalTranscripts(spec)) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(t.absPath);
      } catch {
        continue;
      }
      const prevEntry = prev?.agents?.[spec.id]?.[t.sessionId];
      if (prevEntry && ledgerUnchanged(ledger, t.absPath, stat.size, stat.mtimeMs)) {
        agentManifest[t.sessionId] = prevEntry; // unchanged: reuse, no read, no upload
        result.pushSkipped++;
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(t.absPath, 'utf-8');
      } catch {
        continue;
      }
      // Identity for CRDT merge is the PLAINTEXT hash (ciphertext is
      // non-deterministic), so hash + manifest are computed on cleartext; only
      // the stored object body is sealed.
      const hash = hashContent(content);
      const { lastTs } = transcriptStats(content);
      const entry: ManifestEntry = { relKey: t.relKey, size: stat.size, hash, lastTs };
      const body = encKey ? encryptTranscript(content, encKey) : content;
      const contentType = encKey ? 'application/json' : 'application/x-ndjson';
      try {
        await r2.put(objectKey(me, spec.id, t.sessionId), body, contentType);
        ledgerRecord(ledger, t.absPath, stat.size, stat.mtimeMs, hash);
        agentManifest[t.sessionId] = entry;
        result.pushed++;
        if (opts.verbose) opts.log?.(`  push ${spec.id}/${t.sessionId.slice(0, 8)} (${stat.size}B)`);
      } catch (err) {
        result.errors.push(`push ${spec.id}/${t.sessionId}: ${(err as Error).message}`);
      }
    }
    if (Object.keys(agentManifest).length > 0) manifest.agents[spec.id] = agentManifest;
  }

  try {
    await r2.put(manifestKey(me), JSON.stringify(manifest), 'application/json');
    saveLocalManifest(manifest);
    saveLedger(ledger);
  } catch (err) {
    result.errors.push(`manifest publish: ${(err as Error).message}`);
  }
}

export interface RemoteCopy {
  machine: string;
  entry: ManifestEntry;
}

export interface PendingSession {
  agentId: string;
  sessionId: string;
  copies: RemoteCopy[];
  /** Signature of source hashes — stored in pull state once applied. */
  sig: string;
}

/**
 * Decide which remote sessions need fetching this tick. Pure: no I/O.
 * Skips sessions we hold locally (home wins) and sessions whose source set is
 * unchanged since we last materialized them (pull-state hit → quiescence).
 */
export function selectSessionsToFetch(
  copies: Map<string, Map<string, RemoteCopy[]>>,
  localIdsByAgent: Map<string, Set<string>>,
  pullState: PullState,
): PendingSession[] {
  const pending: PendingSession[] = [];
  for (const [agentId, byAgent] of copies) {
    const localIds = localIdsByAgent.get(agentId) ?? new Set<string>();
    for (const [sessionId, list] of byAgent) {
      if (localIds.has(sessionId)) continue;
      const sig = sourceSignature(list.map(c => c.entry.hash));
      if (pullState[`${agentId}/${sessionId}`] === sig) continue;
      pending.push({ agentId, sessionId, copies: list, sig });
    }
  }
  return pending;
}

/**
 * Resolve the mirror destination + merged content for one session. Pure.
 * The canonical path comes from the lexicographically-smallest machine so every
 * puller derives an identical location; the content is the CRDT union of copies.
 */
export function resolveMirrorWrite(
  spec: SyncAgentSpec,
  copies: RemoteCopy[],
  contents: string[],
): { dest: string; content: string; merged: boolean } {
  const canonical = [...copies].sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0))[0];
  const content = contents.length === 1 ? contents[0] : mergeTranscripts(contents);
  return {
    dest: mirrorPath(spec, canonical.machine, canonical.entry.relKey),
    content,
    merged: contents.length > 1,
  };
}

/**
 * Decide how to reconcile one session's fetched copies. Pure: no I/O.
 *
 * `fetched` is positionally aligned to `copies` — a `null` slot means that
 * copy's object wasn't retrievable this tick (R2 404 / LIST→GET consistency
 * lag / a transient get error). If ANY listed copy is missing, returns `null`:
 * the caller must then skip the mirror write AND skip stamping pull-state, so
 * the session is retried next tick. Writing a partial set instead would
 * materialize a non-converged union and — because pull-state would record the
 * full source signature — abandon the missing branch forever (the bug this
 * guards: a signature match in selectSessionsToFetch never re-fetches it).
 */
export function reconcileCopies(
  spec: SyncAgentSpec,
  copies: RemoteCopy[],
  fetched: Array<string | null>,
): { dest: string; content: string; merged: boolean } | null {
  const contents: string[] = [];
  for (const text of fetched) {
    if (text === null) return null; // incomplete fetch — retry next tick
    contents.push(text);
  }
  if (contents.length === 0) return null;
  return resolveMirrorWrite(spec, copies, contents);
}

/** Fetch other machines' manifests, union changed sessions into the mirror. */
async function pullAndReconcile(r2: R2Client, me: string, encKey: Buffer | null, opts: SyncOptions, result: SyncResult): Promise<void> {
  const prefixes = await r2.listPrefixes(SESSIONS_PREFIX); // sessions/<machine>/
  const machines = prefixes
    .map(p => p.slice(SESSIONS_PREFIX.length).replace(/\/$/, ''))
    .filter(m => m && m !== me);

  // agentId -> sessionId -> copies across machines
  const copies = new Map<string, Map<string, RemoteCopy[]>>();
  for (const m of machines) {
    let manifest: Manifest | null = null;
    try {
      const text = await r2.get(manifestKey(m));
      manifest = text ? parseManifest(text) : null;
    } catch (err) {
      result.errors.push(`fetch manifest ${m}: ${(err as Error).message}`);
    }
    if (!manifest) continue;
    for (const [agentId, sessions] of Object.entries(manifest.agents)) {
      if (!specById(agentId)) continue;
      let byAgent = copies.get(agentId);
      if (!byAgent) copies.set(agentId, (byAgent = new Map()));
      for (const [sessionId, entry] of Object.entries(sessions)) {
        const list = byAgent.get(sessionId) ?? [];
        list.push({ machine: m, entry });
        byAgent.set(sessionId, list);
      }
    }
  }

  const pullState = loadPullState();
  const localIdsByAgent = new Map<string, Set<string>>();
  for (const agentId of copies.keys()) {
    const spec = specById(agentId);
    if (spec) localIdsByAgent.set(agentId, localSessionIds(spec));
  }

  const pending = selectSessionsToFetch(copies, localIdsByAgent, pullState);
  let candidates = 0;
  for (const byAgent of copies.values()) candidates += byAgent.size;
  result.pullSkipped += candidates - pending.length; // local-owned or unchanged

  for (const { agentId, sessionId, copies: list, sig } of pending) {
    const spec = specById(agentId)!;

    // Download each copy (could be a fork across >1 machine), keeping the
    // result positionally aligned to `list` — null marks a copy we couldn't
    // fetch this tick (404 / consistency lag / error).
    const fetched: Array<string | null> = [];
    for (const c of list) {
      try {
        const body = await r2.get(objectKey(c.machine, agentId, sessionId));
        // Decrypt before the body reaches the CRDT union — the merge and the
        // mirror always operate on plaintext. A legacy plaintext object passes
        // through untouched; an envelope without a key throws (surfaced below).
        fetched.push(body === null ? null : decryptTranscriptBody(body, encKey));
      } catch (err) {
        result.errors.push(`get ${c.machine}/${sessionId}: ${(err as Error).message}`);
        fetched.push(null);
      }
    }
    // null ⇒ an incomplete fetch: skip the write AND the pull-state stamp so we
    // retry next tick instead of persisting a partial union / abandoning a branch.
    const resolved = reconcileCopies(spec, list, fetched);
    if (!resolved) continue;
    const { dest, content, merged } = resolved;

    try {
      let existing: string | null = null;
      try {
        existing = fs.readFileSync(dest, 'utf-8');
      } catch { /* not present yet */ }
      if (existing !== content) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, 'utf-8');
        if (merged) result.merged++;
        result.pulled++;
        if (opts.verbose) {
          opts.log?.(`  pull ${agentId}/${sessionId.slice(0, 8)} <- ${list.map(c => c.machine).join('+')}`);
        }
      } else {
        result.pullSkipped++;
      }
      pullState[`${agentId}/${sessionId}`] = sig;
    } catch (err) {
      result.errors.push(`write mirror ${sessionId}: ${(err as Error).message}`);
    }
  }

  savePullState(pullState);
}

/** Run one full sync cycle: push this machine's changes, pull everyone else's. */
export async function syncSessions(opts: SyncOptions = {}): Promise<SyncResult> {
  const cfg = loadR2Config();
  const me = machineId();
  const r2 = new R2Client(cfg);
  const encKey = resolveSyncEncKey(cfg); // shared client-side transcript key, or null
  const result: SyncResult = {
    machine: me,
    pushed: 0,
    pushSkipped: 0,
    pulled: 0,
    merged: 0,
    pullSkipped: 0,
    errors: [],
    warnings: [],
  };

  if (opts.push !== false) await pushOwn(r2, me, encKey, opts, result);
  if (opts.pull !== false) await pullAndReconcile(r2, me, encKey, opts, result);
  return result;
}
