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
  isMergeableFile,
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
  manifestEntries,
  type AgentManifest,
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
    const agentManifest: AgentManifest = {};
    for (const t of listLocalTranscripts(spec)) {
      // A session is one file (file-shaped) or many (dir-shaped). Push each file
      // that changed, reusing the prior manifest entry (keyed by relKey) for the
      // ones the ledger shows unchanged. Object keys nest under the session id for
      // dir-shaped agents and stay flat for file-shaped ones (unchanged keys).
      const prevVal = prev?.agents?.[spec.id]?.[t.sessionId];
      const prevByRel = new Map((prevVal ? manifestEntries(prevVal) : []).map(e => [e.relKey, e]));
      const entries: ManifestEntry[] = [];
      for (const f of t.files) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(f.absPath);
        } catch {
          continue;
        }
        const prevEntry = prevByRel.get(f.relKey);
        if (prevEntry && ledgerUnchanged(ledger, f.absPath, stat.size, stat.mtimeMs)) {
          entries.push(prevEntry); // unchanged: reuse, no read, no upload
          result.pushSkipped++;
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(f.absPath, 'utf-8');
        } catch {
          continue;
        }
        // Identity for CRDT merge is the PLAINTEXT hash (ciphertext is
        // non-deterministic), so hash + manifest are computed on cleartext; only
        // the stored object body is sealed.
        const hash = hashContent(content);
        const lastTs = deriveLastTs(spec, f.relKey, content, stat.mtimeMs);
        const entry: ManifestEntry = { relKey: f.relKey, size: stat.size, hash, lastTs };
        const body = encKey ? encryptTranscript(content, encKey) : content;
        const contentType = encKey ? 'application/json' : 'application/x-ndjson';
        try {
          await r2.put(objectKey(me, spec.id, t.sessionId, spec.dirShaped ? f.relKey : undefined), body, contentType);
          ledgerRecord(ledger, f.absPath, stat.size, stat.mtimeMs, hash);
          entries.push(entry);
          result.pushed++;
          const label = spec.dirShaped ? `${t.sessionId.slice(0, 8)}/${f.relKey}` : t.sessionId.slice(0, 8);
          if (opts.verbose) opts.log?.(`  push ${spec.id}/${label} (${stat.size}B)`);
        } catch (err) {
          result.errors.push(`push ${spec.id}/${t.sessionId}/${f.relKey}: ${(err as Error).message}`);
        }
      }
      // File-shaped: store the single entry (byte-identical to the old format so
      // older CLIs read it unchanged). Dir-shaped: store the per-file array.
      if (entries.length > 0) agentManifest[t.sessionId] = spec.dirShaped ? entries : entries[0];
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
 * Resolve the mirror destination + reconciled content for ONE file across its
 * copies (every copy here is the same file — same relKey — held by a different
 * machine). Pure.
 *
 * The canonical path comes from the lexicographically-smallest machine so every
 * puller derives an identical location. The content depends on the file's kind
 * (see `isMergeableFile`):
 *  - append-only logs (a transcript `.jsonl`) take the CRDT G-Set union — every
 *    machine converges to byte-identical output regardless of order.
 *  - mutable blobs (Kimi `state.json`) can't be line-unioned without corruption,
 *    so they resolve **last-writer-wins**: the copy with the latest event
 *    timestamp, tie-broken by content hash so the pick is deterministic fleet-wide.
 */
/**
 * The `lastTs` a manifest entry carries for one file. Append-only logs (a
 * conversation `.jsonl`) embed per-line event timestamps, so their recency is
 * the latest line timestamp (`transcriptStats`). Mutable blobs (Kimi
 * `state.json`, the per-tool `tasks/*.json` sidecars) carry no event timestamp —
 * their own `updatedAt`/`createdAt` fields are agent-specific and unreliable — so
 * their "last written" signal is the file mtime. Without this, `transcriptStats`
 * returns `''` for every blob and the last-writer-wins branch in
 * `resolveMirrorWrite` silently degrades to "highest-hash-wins", which can pick a
 * stale copy over the genuinely newer one.
 */
export function deriveLastTs(spec: SyncAgentSpec, relKey: string, content: string, mtimeMs: number): string {
  if (isMergeableFile(spec, relKey)) return transcriptStats(content).lastTs;
  return new Date(mtimeMs).toISOString();
}

export function resolveMirrorWrite(
  spec: SyncAgentSpec,
  copies: RemoteCopy[],
  contents: string[],
): { dest: string; content: string; merged: boolean } {
  const canonical = [...copies].sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0))[0];
  let content: string;
  if (contents.length === 1) {
    content = contents[0];
  } else if (isMergeableFile(spec, canonical.entry.relKey)) {
    content = mergeTranscripts(contents);
  } else {
    // Last-writer-wins: highest (lastTs, hash) among the copies.
    let win = 0;
    for (let i = 1; i < copies.length; i++) {
      const a = copies[i].entry, b = copies[win].entry;
      if (a.lastTs > b.lastTs || (a.lastTs === b.lastTs && a.hash > b.hash)) win = i;
    }
    content = contents[win];
  }
  return {
    dest: mirrorPath(spec, canonical.machine, canonical.entry.relKey),
    content,
    // "merged" means an actual CRDT line-union happened — not a last-writer-wins
    // pick of one mutable blob over another (that discards a copy, it doesn't merge).
    merged: contents.length > 1 && isMergeableFile(spec, canonical.entry.relKey),
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
      for (const [sessionId, value] of Object.entries(sessions)) {
        const list = byAgent.get(sessionId) ?? [];
        // One RemoteCopy per (machine, file): file-shaped sessions contribute one,
        // dir-shaped ones contribute an entry per constituent file. `manifestEntries`
        // also normalizes a single-object entry written by an older CLI.
        for (const entry of manifestEntries(value)) list.push({ machine: m, entry });
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

    // A dir-shaped session spans several files; reconcile each file independently
    // (its copies across machines share one relKey). File-shaped sessions have a
    // single group, so this collapses to the original one-file path.
    const byRel = new Map<string, RemoteCopy[]>();
    for (const c of list) {
      const g = byRel.get(c.entry.relKey);
      if (g) g.push(c); else byRel.set(c.entry.relKey, [c]);
    }

    // Resolve every file's write before touching disk. If ANY file's fetch is
    // incomplete (a copy 404s / consistency lag), abandon the WHOLE session this
    // tick — no writes, no pull-state stamp — so it retries intact next time
    // rather than materializing half a session and stamping it done.
    const writes: Array<{ dest: string; content: string; merged: boolean }> = [];
    let incomplete = false;
    try {
      for (const group of byRel.values()) {
        const fetched: Array<string | null> = [];
        for (const c of group) {
          try {
            const body = await r2.get(objectKey(c.machine, agentId, sessionId, spec.dirShaped ? c.entry.relKey : undefined));
            // Decrypt before the body reaches the CRDT union — merge + mirror always
            // operate on plaintext. A legacy plaintext object passes through
            // untouched; an envelope without a key throws (surfaced below).
            fetched.push(body === null ? null : decryptTranscriptBody(body, encKey));
          } catch (err) {
            result.errors.push(`get ${c.machine}/${sessionId}/${c.entry.relKey}: ${(err as Error).message}`);
            fetched.push(null);
          }
        }
        const resolved = reconcileCopies(spec, group, fetched);
        if (!resolved) { incomplete = true; break; }
        writes.push(resolved);
      }
    } catch (err) {
      // `reconcileCopies` -> `mirrorPath` now rejects unsafe peer-controlled
      // machine/relKey (C1 containment). That rejection must stay scoped to this
      // one session: without this catch a single malicious/malformed manifest
      // entry would throw out of the whole `pending` loop, skip the
      // `savePullState` below, and re-throw every tick — a peer-triggered DoS on
      // everyone else's session-sync. Record it and skip; never stamp pull-state
      // for a rejected entry (so nothing marks the bad session "done").
      result.errors.push(`resolve mirror ${agentId}/${sessionId}: ${(err as Error).message}`);
      continue;
    }
    if (incomplete) continue; // retry next tick, session intact

    try {
      let changed = false;
      let mergedAny = false;
      for (const { dest, content, merged } of writes) {
        let existing: string | null = null;
        try {
          existing = fs.readFileSync(dest, 'utf-8');
        } catch { /* not present yet */ }
        if (existing !== content) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, content, 'utf-8');
          changed = true;
          if (merged) mergedAny = true;
        }
      }
      if (changed) {
        if (mergedAny) result.merged++;
        result.pulled++;
        if (opts.verbose) {
          const machines = [...new Set(list.map(c => c.machine))].join('+');
          const files = byRel.size > 1 ? ` (${byRel.size} files)` : '';
          opts.log?.(`  pull ${agentId}/${sessionId.slice(0, 8)}${files} <- ${machines}`);
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
