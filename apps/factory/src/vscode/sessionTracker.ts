import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseSessionHead,
  sessionIdFromFile,
  workspaceHash,
} from '../monitor/sessionParse';
import { SessionFactPayload } from '../monitor/protocol';
import { captureProcessStartTime, pickNewestStartTime } from '../core/processStartTime';

export type TrackedAgentType = 'claude' | 'codex' | 'gemini' | 'opencode';

type SessionChangeListener = (
  terminal: vscode.Terminal,
  oldId: string | undefined,
  newId: string,
) => void;

interface TrackedTerminal {
  terminal: vscode.Terminal;
  agentType: TrackedAgentType;
  workspacePath: string;
  sessionId?: string;
  trackedFile?: string;
  // The watcher roots actually mounted for this terminal, captured at register
  // time (plus any opencode roots resolved asynchronously afterwards). Release
  // exactly these on unregister so mount/release stays symmetric even when the
  // opencode root set is discovered lazily.
  mountedRoots?: string[];
  // setTimeout handles for the deferred adoption retries (450ms, 1200ms), so
  // they can be cancelled if the terminal closes before they fire.
  adoptionRetryTimers?: NodeJS.Timeout[];
  // Shell process start time (epoch ms), captured once at registration via a
  // single `ps`. Lets kill/restart correlation pick the newest dormant terminal
  // without spawning pgrep + ps per session-file event (#97).
  startTimeMs?: number;
}

interface SharedWatcher {
  watcher: fs.FSWatcher;
  pollListener: (curr: fs.Stats, prev: fs.Stats) => void;
  knownFiles: Set<string>;
  refCount: number;
  dir: string;
  agentType: TrackedAgentType;
}

const DEBOUNCE_MS = 300;
const DORMANT_THRESHOLD_MS = 10_000;
// Bound the codex adoption scan: only the most-recent N session files by mtime
// are inspected per call (a freshly launched session is always near the top).
const CODEX_ADOPT_MAX_FILES = 40;
// Cache parsed codex session cwd by file+mtime so the immediate + 450ms +
// 1200ms retries (and concurrent terminals) don't re-readline the same files.
const CODEX_CWD_CACHE_MAX = 500;
const codexCwdCache = new Map<string, string | undefined>();

function getCodexCwd(file: string, mtimeMs: number): Promise<string | undefined> {
  const key = `${file}:${mtimeMs}`;
  if (codexCwdCache.has(key)) return Promise.resolve(codexCwdCache.get(key));
  return parseSessionHead(file, 'codex').then((parsed) => {
    if (codexCwdCache.size >= CODEX_CWD_CACHE_MAX) {
      const oldest = codexCwdCache.keys().next().value;
      if (oldest !== undefined) codexCwdCache.delete(oldest);
    }
    codexCwdCache.set(key, parsed.codexCwd);
    return parsed.codexCwd;
  });
}
// Bound for `lastWriteMs`: every fs.watch event on a watched session dir adds
// an entry, but we only delete entries for tracked files. Without an upper
// bound the map grows for the entire extension-host lifetime — over a long
// day it accumulates thousands of stale paths.
const LAST_WRITE_MAX = 5000;

// --- Monitor follower routing (#69) ---------------------------------------
//
// When connected to the centralized monitor, the leader runs ONE machine-wide
// fs.watch per session root and broadcasts parsed session + warmth facts; this
// window resolves each to its own terminal via the SAME correlation it runs
// locally (ingestSessionFact / ingestSessionWarmth). Local watcher mounting is
// therefore suppressed while connected. The one-shot adoption read on register
// stays local. When disconnected everything falls back to local watching.
let monitorConnected: () => boolean = () => false;

/** Wire the predicate that decides local-vs-broadcast session watching. */
export function setMonitorConnectivity(fn: () => boolean): void {
  monitorConnected = fn;
}

let initialized = false;
let listeners: SessionChangeListener[] = [];
const tracked = new Map<vscode.Terminal, TrackedTerminal>();
const watchersByDir = new Map<string, SharedWatcher>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
const lastWriteMs = new Map<string, number>();
const codexAdoptionClaims = new Set<string>();
let midnightTimer: NodeJS.Timeout | undefined;

function homeDir(): string {
  return os.homedir();
}

function workspaceToClaudeFolder(workspacePath: string): string {
  return workspacePath.replace(/[\/\.]/g, '-');
}

// Cached enumeration of installed Claude versions. Without this, every
// terminal registration runs a synchronous readdir on the extension-host
// thread.
let cachedClaudeVersions: string[] | undefined;

function claudeVersionDirs(): string[] {
  if (cachedClaudeVersions) return cachedClaudeVersions;
  const versionsDir = path.join(homeDir(), '.agents', '.history', 'versions', 'claude');
  const versions: string[] = [];
  if (fs.existsSync(versionsDir)) {
    try {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) versions.push(entry.name);
      }
    } catch {
      /* ignore */
    }
  }
  cachedClaudeVersions = versions;
  return versions;
}

function claudeRootsFor(workspacePath: string): string[] {
  const folder = workspaceToClaudeFolder(workspacePath);
  const roots: string[] = [path.join(homeDir(), '.claude', 'projects', folder)];
  const versionsDir = path.join(homeDir(), '.agents', '.history', 'versions', 'claude');
  for (const ver of claudeVersionDirs()) {
    roots.push(path.join(versionsDir, ver, 'home', '.claude', 'projects', folder));
  }
  return roots;
}

function codexRootToday(): string {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return path.join(homeDir(), '.codex', 'sessions', y, m, d);
}

function codexRootYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(homeDir(), '.codex', 'sessions', y, m, day);
}

function geminiRootsFor(workspacePath: string): string[] {
  const base = path.basename(workspacePath);
  const hash = workspaceHash(workspacePath);
  const roots: string[] = [
    path.join(homeDir(), '.gemini', 'tmp', hash, 'chats'),
    path.join(homeDir(), '.gemini', 'tmp', base, 'chats'),
  ];
  return [...new Set(roots)];
}

// Opencode maps a workspace to its session dirs by scanning every project
// JSON. That scan used to run synchronously (readdirSync + readFileSync of
// EVERY project file) inside registerTerminal on the activation path. It now
// runs off-thread via fs.promises and is cached per workspace; the sync getter
// only returns what's already cached so terminal registration never blocks.
const opencodeRootsCache = new Map<string, string[]>();
const opencodeRootsInFlight = new Map<string, Promise<string[]>>();

function opencodeRootsFor(workspacePath: string): string[] {
  return opencodeRootsCache.get(workspacePath) ?? [];
}

async function resolveOpencodeRoots(workspacePath: string): Promise<string[]> {
  const projectRoot = path.join(homeDir(), '.local', 'share', 'opencode', 'storage', 'project');
  const sessionRoot = path.join(homeDir(), '.local', 'share', 'opencode', 'storage', 'session');
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.json')) return;
      const fullPath = path.join(projectRoot, entry.name);
      try {
        const raw = await fs.promises.readFile(fullPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const worktree = parsed?.worktree;
        const id = parsed?.id;
        if (worktree === workspacePath && typeof id === 'string' && id.length > 0) {
          roots.push(path.join(sessionRoot, id));
        }
      } catch {
        /* ignore malformed project json */
      }
    }),
  );
  return [...new Set(roots)];
}

function ensureOpencodeRoots(workspacePath: string): Promise<string[]> {
  const cached = opencodeRootsCache.get(workspacePath);
  if (cached) return Promise.resolve(cached);
  let inflight = opencodeRootsInFlight.get(workspacePath);
  if (!inflight) {
    inflight = resolveOpencodeRoots(workspacePath)
      .then((roots) => {
        opencodeRootsCache.set(workspacePath, roots);
        opencodeRootsInFlight.delete(workspacePath);
        return roots;
      })
      .catch(() => {
        opencodeRootsInFlight.delete(workspacePath);
        return [];
      });
    opencodeRootsInFlight.set(workspacePath, inflight);
  }
  return inflight;
}

function msUntilNextMidnight(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 30, 0);
  return next.getTime() - now.getTime();
}

function ensureDirExists(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return fs.existsSync(dir);
  }
}

function rootsFor(t: TrackedTerminal): string[] {
  switch (t.agentType) {
    case 'claude':
      return claudeRootsFor(t.workspacePath);
    case 'codex':
      return [codexRootToday(), codexRootYesterday()];
    case 'gemini':
      return geminiRootsFor(t.workspacePath);
    case 'opencode':
      return opencodeRootsFor(t.workspacePath);
    default:
      return [];
  }
}

// Insertion-order eviction: Map keeps insertion order, so the first key is
// the oldest. Drop one when we exceed the cap, then re-insert (which moves
// existing keys to the end).
function recordWrite(filePath: string): void {
  if (lastWriteMs.has(filePath)) {
    lastWriteMs.delete(filePath);
  } else if (lastWriteMs.size >= LAST_WRITE_MAX) {
    const oldest = lastWriteMs.keys().next().value;
    if (oldest !== undefined) lastWriteMs.delete(oldest);
  }
  lastWriteMs.set(filePath, Date.now());
}

function mountWatcher(dir: string, agentType: TrackedAgentType): void {
  // Connected: the monitor owns the single machine-wide watcher per root; this
  // window consumes broadcast facts instead of mounting its own fs.watch.
  if (monitorConnected()) return;
  if (watchersByDir.has(dir)) {
    watchersByDir.get(dir)!.refCount++;
    return;
  }
  if (!ensureDirExists(dir)) return;
  try {
    let knownFiles = new Set<string>();
    try {
      knownFiles = new Set(fs.readdirSync(dir));
    } catch {
      knownFiles = new Set();
    }
    const watcher = fs.watch(dir, { recursive: false }, (event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      knownFiles.add(name);
      if (event === 'change') {
        recordWrite(path.join(dir, name));
      }
      if (event === 'rename' || event === 'change') {
        onRename(dir, name, agentType);
      }
    });
    const pollListener = (curr: fs.Stats, prev: fs.Stats): void => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (knownFiles.has(name)) continue;
        knownFiles.add(name);
        onRename(dir, name, agentType);
      }
    };
    fs.watchFile(dir, { interval: 100 }, pollListener);
    watchersByDir.set(dir, { watcher, pollListener, knownFiles, refCount: 1, dir, agentType });
  } catch {
    /* ignore */
  }
}

function releaseWatcher(dir: string): void {
  const w = watchersByDir.get(dir);
  if (!w) return;
  w.refCount--;
  if (w.refCount <= 0) {
    try {
      w.watcher.close();
      fs.unwatchFile(dir, w.pollListener);
    } catch {
      /* ignore */
    }
    watchersByDir.delete(dir);
  }
}

function onRename(dir: string, filename: string, agentType: TrackedAgentType): void {
  const isJsonlAgent = agentType === 'claude' || agentType === 'codex';
  if (isJsonlAgent && !filename.endsWith('.jsonl')) return;
  if (!isJsonlAgent && !filename.endsWith('.json')) return;
  const full = path.join(dir, filename);
  const existing = debounceTimers.get(full);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(full);
    if (!fs.existsSync(full)) return;
    void processNewFile(full, agentType).catch(() => {});
  }, DEBOUNCE_MS);
  debounceTimers.set(full, timer);
}

async function processNewFile(file: string, agentType: TrackedAgentType): Promise<void> {
  const parsed = await parseSessionHead(file, agentType);
  await applyParsedCorrelation(file, agentType, parsed);
}

// The correlation half of processNewFile, split out so a broadcast session fact
// (already parsed by the monitor's watcher) drives the identical, window-local
// terminal<->sessionId mapping without re-reading the file.
async function applyParsedCorrelation(
  file: string,
  agentType: TrackedAgentType,
  parsed: SessionFactPayload | { forkedFromId?: string; codexCwd?: string; geminiProjectHash?: string; geminiSessionId?: string; opencodeDirectory?: string; opencodeSessionId?: string },
): Promise<void> {
  let newId = sessionIdFromFile(file);

  if (agentType === 'claude' && parsed.forkedFromId) {
    const match = findTrackedBySessionId(parsed.forkedFromId, 'claude');
    if (match) {
      applyChange(match, newId, file);
      return;
    }
  }

  if (agentType === 'codex') {
    const candidates = [...tracked.values()].filter(t => t.agentType === 'codex');
    if (parsed.codexCwd) {
      const match = candidates.find(
        t => t.workspacePath === parsed.codexCwd && (!t.sessionId || t.sessionId === newId)
      );
      if (match) {
        applyChange(match, newId, file);
        return;
      }
    }
  }

  if (agentType === 'gemini') {
    if (parsed.geminiSessionId) newId = parsed.geminiSessionId;
    if (isSessionIdAlreadyTracked('gemini', newId)) return;
    if (parsed.geminiProjectHash) {
      const candidates = [...tracked.values()].filter(t =>
        t.agentType === 'gemini' && workspaceHash(t.workspacePath) === parsed.geminiProjectHash
      );
      const match = candidates.find(t => !t.sessionId || t.sessionId === newId);
      if (match) {
        applyChange(match, newId, file);
        return;
      }
    }
  }

  if (agentType === 'opencode') {
    if (parsed.opencodeSessionId) newId = parsed.opencodeSessionId;
    if (isSessionIdAlreadyTracked('opencode', newId)) return;
    if (parsed.opencodeDirectory) {
      const candidates = [...tracked.values()].filter(t =>
        t.agentType === 'opencode' && t.workspacePath === parsed.opencodeDirectory
      );
      const match = candidates.find(t => !t.sessionId || t.sessionId === newId);
      if (match) {
        applyChange(match, newId, file);
        return;
      }
    }
  }

  await correlateKillRestart(file, newId, agentType);
}

// Apply a broadcast session fact (#69): same correlation as the local watcher,
// but the file was already parsed by the monitor.
export function ingestSessionFact(payload: SessionFactPayload): void {
  void applyParsedCorrelation(payload.filePath, payload.agentType, payload).catch(() => {});
}

// Apply a broadcast warmth fact: keep this window's dormancy clock current so
// kill/restart correlation still works while the local watcher is suppressed.
export function ingestSessionWarmth(filePath: string): void {
  recordWrite(filePath);
}

function findTrackedBySessionId(
  sessionId: string,
  agentType: TrackedAgentType,
): TrackedTerminal | undefined {
  for (const t of tracked.values()) {
    if (t.agentType === agentType && t.sessionId === sessionId) return t;
  }
  return undefined;
}

async function correlateKillRestart(
  file: string,
  newId: string,
  agentType: TrackedAgentType,
): Promise<void> {
  const now = Date.now();
  const dormant = [...tracked.values()].filter(t => {
    if (t.agentType !== agentType) return false;
    if (!t.trackedFile) return false;
    const last = lastWriteMs.get(t.trackedFile) ?? 0;
    return now - last > DORMANT_THRESHOLD_MS;
  });

  if (dormant.length === 0) return;
  if (dormant.length === 1) {
    applyChange(dormant[0], newId, file);
    return;
  }

  const picked = pickNewestStartTime(dormant);
  if (picked) applyChange(picked, newId, file);
}

// Capture the shell's process start time once at registration so kill/restart
// correlation can compare cached values instead of spawning pgrep + ps per
// dormant terminal on every session-file rename (#97).
async function captureStartTime(entry: TrackedTerminal): Promise<void> {
  try {
    const pid = await entry.terminal.processId;
    if (!pid) return;
    if (tracked.get(entry.terminal) !== entry) return;
    const start = await captureProcessStartTime(pid);
    if (start !== undefined && tracked.get(entry.terminal) === entry) {
      entry.startTimeMs = start;
    }
  } catch {
    /* best-effort: start time stays undefined and is skipped in selection */
  }
}

function applyChange(t: TrackedTerminal, newId: string, file: string): void {
  const current = tracked.get(t.terminal);
  if (current !== t) return;
  if (t.sessionId === newId) return;
  const old = t.sessionId;
  t.sessionId = newId;
  t.trackedFile = file;
  lastWriteMs.set(file, Date.now());
  for (const l of listeners) {
    try {
      l(t.terminal, old, newId);
    } catch (err) {
      console.error('[sessionTracker] listener threw', err);
    }
  }
}

function isSessionIdAlreadyTracked(
  agentType: TrackedAgentType,
  sessionId: string,
  exclude?: vscode.Terminal,
): boolean {
  for (const t of tracked.values()) {
    if (exclude && t.terminal === exclude) continue;
    if (t.agentType !== agentType) continue;
    if (t.sessionId === sessionId) return true;
  }
  return false;
}

async function adoptExistingCodexSession(
  t: TrackedTerminal,
  rootsOverride?: string[],
): Promise<void> {
  if (t.agentType !== 'codex' || t.sessionId) return;

  const roots = rootsOverride && rootsOverride.length > 0 ? rootsOverride : rootsFor(t);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    let files: Array<{ file: string; mtimeMs: number }> = [];
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const jsonlFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => path.join(root, e.name));
      const stats = await Promise.all(
        jsonlFiles.map(async (file) => {
          try {
            const stat = await fs.promises.stat(file);
            return { file, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      files = stats.filter((v): v is { file: string; mtimeMs: number } => v !== null);
    } catch {
      continue;
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const candidate of files.slice(0, CODEX_ADOPT_MAX_FILES)) {
      const candidateId = sessionIdFromFile(candidate.file);
      if (isSessionIdAlreadyTracked('codex', candidateId, t.terminal)) continue;
      if (codexAdoptionClaims.has(candidateId)) continue;

      codexAdoptionClaims.add(candidateId);
      try {
        if (isSessionIdAlreadyTracked('codex', candidateId, t.terminal)) continue;

        const cwd = await getCodexCwd(candidate.file, candidate.mtimeMs);
        if (cwd !== t.workspacePath) continue;
        applyChange(t, candidateId, candidate.file);
        return;
      } finally {
        codexAdoptionClaims.delete(candidateId);
      }
    }
  }
}

async function adoptExistingClaudeFork(
  t: TrackedTerminal,
  rootsOverride?: string[],
): Promise<void> {
  if (t.agentType !== 'claude' || !t.sessionId) return;

  const roots = rootsOverride && rootsOverride.length > 0 ? rootsOverride : rootsFor(t);
  const expectedForkFrom = t.sessionId;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    let files: Array<{ file: string; mtimeMs: number }> = [];
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const jsonlFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => path.join(root, e.name));
      const stats = await Promise.all(
        jsonlFiles.map(async (file) => {
          try {
            const stat = await fs.promises.stat(file);
            return { file, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      files = stats.filter((v): v is { file: string; mtimeMs: number } => v !== null);
    } catch {
      continue;
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of files.slice(0, 120)) {
      const parsed = await parseSessionHead(candidate.file, 'claude');
      if (parsed.forkedFromId !== expectedForkFrom) continue;
      const candidateId = sessionIdFromFile(candidate.file);
      if (isSessionIdAlreadyTracked('claude', candidateId, t.terminal)) continue;
      applyChange(t, candidateId, candidate.file);
      return;
    }
  }
}

async function adoptExistingGeminiSession(
  t: TrackedTerminal,
  rootsOverride?: string[],
): Promise<void> {
  if (t.agentType !== 'gemini' || t.sessionId) return;

  const roots = rootsOverride && rootsOverride.length > 0 ? rootsOverride : rootsFor(t);
  const expectedHash = workspaceHash(t.workspacePath);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    let files: Array<{ file: string; mtimeMs: number }> = [];
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const jsonFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => path.join(root, e.name));
      const stats = await Promise.all(
        jsonFiles.map(async (file) => {
          try {
            const stat = await fs.promises.stat(file);
            return { file, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      files = stats.filter((v): v is { file: string; mtimeMs: number } => v !== null);
    } catch {
      continue;
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const candidate of files.slice(0, 120)) {
      const parsed = await parseSessionHead(candidate.file, 'gemini');
      const candidateId = parsed.geminiSessionId;
      if (!candidateId) continue;
      if (parsed.geminiProjectHash !== expectedHash) continue;
      if (isSessionIdAlreadyTracked('gemini', candidateId, t.terminal)) continue;
      applyChange(t, candidateId, candidate.file);
      return;
    }
  }
}

async function adoptExistingOpencodeSession(
  t: TrackedTerminal,
  rootsOverride?: string[],
): Promise<void> {
  if (t.agentType !== 'opencode' || t.sessionId) return;

  const roots = rootsOverride && rootsOverride.length > 0 ? rootsOverride : rootsFor(t);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    let files: Array<{ file: string; mtimeMs: number }> = [];
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const jsonFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => path.join(root, e.name));
      const stats = await Promise.all(
        jsonFiles.map(async (file) => {
          try {
            const stat = await fs.promises.stat(file);
            return { file, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      files = stats.filter((v): v is { file: string; mtimeMs: number } => v !== null);
    } catch {
      continue;
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const candidate of files.slice(0, 120)) {
      const parsed = await parseSessionHead(candidate.file, 'opencode');
      const candidateId = parsed.opencodeSessionId;
      if (!candidateId) continue;
      if (parsed.opencodeDirectory !== t.workspacePath) continue;
      if (isSessionIdAlreadyTracked('opencode', candidateId, t.terminal)) continue;
      applyChange(t, candidateId, candidate.file);
      return;
    }
  }
}

async function adoptExistingSessionForTerminal(
  t: TrackedTerminal,
  rootsOverride?: string[],
): Promise<void> {
  if (t.agentType === 'claude') {
    await adoptExistingClaudeFork(t, rootsOverride);
    return;
  }
  if (t.agentType === 'codex') {
    await adoptExistingCodexSession(t, rootsOverride);
    return;
  }
  if (t.agentType === 'gemini') {
    await adoptExistingGeminiSession(t, rootsOverride);
    return;
  }
  if (t.agentType === 'opencode') {
    await adoptExistingOpencodeSession(t, rootsOverride);
  }
}

function scheduleAdoptionRetry(
  terminal: vscode.Terminal,
  entry: TrackedTerminal,
  rootsOverride?: string[],
): void {
  const delays = [450, 1200];
  const timers = entry.adoptionRetryTimers ?? (entry.adoptionRetryTimers = []);
  for (const delayMs of delays) {
    const handle = setTimeout(() => {
      if (tracked.get(terminal) !== entry) return;
      void adoptExistingSessionForTerminal(entry, rootsOverride);
    }, delayMs);
    timers.push(handle);
  }
}

export function initSessionTracker(context: vscode.ExtensionContext): void {
  if (initialized) return;
  initialized = true;

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(term => unregisterTerminal(term)),
  );

  const rearmCodex = (): void => {
    const activeCodex = [...tracked.values()].filter(t => t.agentType === 'codex');
    if (activeCodex.length > 0) {
      mountWatcher(codexRootToday(), 'codex');
      mountWatcher(codexRootYesterday(), 'codex');
    }
    midnightTimer = setTimeout(rearmCodex, msUntilNextMidnight());
  };
  midnightTimer = setTimeout(rearmCodex, msUntilNextMidnight());

  context.subscriptions.push({
    dispose: () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      for (const [, sw] of watchersByDir) {
        try {
          sw.watcher.close();
        } catch {
          /* ignore */
        }
      }
      watchersByDir.clear();
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      for (const entry of tracked.values()) {
        if (entry.adoptionRetryTimers) {
          for (const timer of entry.adoptionRetryTimers) clearTimeout(timer);
        }
      }
      tracked.clear();
      lastWriteMs.clear();
      codexAdoptionClaims.clear();
      codexCwdCache.clear();
      opencodeRootsCache.clear();
      opencodeRootsInFlight.clear();
      listeners = [];
      initialized = false;
    },
  });
}

export function registerTerminal(
  terminal: vscode.Terminal,
  agentType: TrackedAgentType,
  workspacePath: string,
  currentSessionId?: string,
): void {
  const existing = tracked.get(terminal);
  if (existing) {
    if (currentSessionId) existing.sessionId = currentSessionId;
    return;
  }
  const entry: TrackedTerminal = {
    terminal,
    agentType,
    workspacePath,
    sessionId: currentSessionId,
  };
  tracked.set(terminal, entry);
  void captureStartTime(entry);
  const initialRoots = rootsFor(entry);
  entry.mountedRoots = [...initialRoots];
  for (const root of initialRoots) {
    mountWatcher(root, agentType);
  }

  // VS Code may restore terminals without AGENT_SESSION_ID in env.
  // Recover immediately by scanning existing session files for this workspace
  // instead of waiting only for brand-new file events.
  if ((agentType === 'claude' && currentSessionId) || (agentType !== 'claude' && !currentSessionId)) {
    void adoptExistingSessionForTerminal(entry);
    // Fallback for environments where fs.watch may miss/deny create events.
    scheduleAdoptionRetry(terminal, entry);
  }

  // Opencode roots are resolved off the activation path (see ensureOpencodeRoots).
  // Once resolved, mount any newly discovered roots and run adoption against
  // them; mounted roots are tracked so unregister releases them symmetrically.
  if (agentType === 'opencode') {
    void ensureOpencodeRoots(workspacePath).then((roots) => {
      if (tracked.get(terminal) !== entry) return;
      const already = entry.mountedRoots ?? (entry.mountedRoots = []);
      for (const root of roots) {
        if (already.includes(root)) continue;
        mountWatcher(root, agentType);
        already.push(root);
      }
      if (roots.length > 0 && !entry.sessionId) {
        void adoptExistingSessionForTerminal(entry, roots);
      }
    });
  }
}

export function unregisterTerminal(terminal: vscode.Terminal): void {
  const entry = tracked.get(terminal);
  if (!entry) return;
  tracked.delete(terminal);
  if (entry.adoptionRetryTimers) {
    for (const timer of entry.adoptionRetryTimers) clearTimeout(timer);
    entry.adoptionRetryTimers = undefined;
  }
  if (entry.trackedFile) lastWriteMs.delete(entry.trackedFile);
  for (const root of entry.mountedRoots ?? rootsFor(entry)) {
    releaseWatcher(root);
  }
}

export function onSessionChanged(listener: SessionChangeListener): vscode.Disposable {
  listeners.push(listener);
  return {
    dispose: () => {
      listeners = listeners.filter(l => l !== listener);
    },
  };
}

export function __reset(): void {
  for (const [, sw] of watchersByDir) {
    try {
      sw.watcher.close();
      fs.unwatchFile(sw.dir, sw.pollListener);
    } catch {
      /* ignore */
    }
  }
  watchersByDir.clear();
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  if (midnightTimer) clearTimeout(midnightTimer);
  midnightTimer = undefined;
  for (const entry of tracked.values()) {
    if (entry.adoptionRetryTimers) {
      for (const timer of entry.adoptionRetryTimers) clearTimeout(timer);
    }
  }
  tracked.clear();
  lastWriteMs.clear();
  codexAdoptionClaims.clear();
  codexCwdCache.clear();
  opencodeRootsCache.clear();
  opencodeRootsInFlight.clear();
  listeners = [];
  initialized = false;
  cachedClaudeVersions = undefined;
  monitorConnected = () => false;
}

// Read the start time captured at registration (#97). Test-only: lets a real
// registerTerminal + real `ps` round-trip be asserted without exposing the
// private tracked map.
export function __testGetStartTime(terminal: vscode.Terminal): number | undefined {
  return tracked.get(terminal)?.startTimeMs;
}

export function __testRegister(
  terminal: vscode.Terminal,
  agentType: TrackedAgentType,
  rootDirs: string[],
  currentSessionId?: string,
  workspacePath: string = '/__test__',
): void {
  const entry: TrackedTerminal = {
    terminal,
    agentType,
    workspacePath,
    sessionId: currentSessionId,
  };
  tracked.set(terminal, entry);
  entry.mountedRoots = [...rootDirs];
  for (const root of rootDirs) mountWatcher(root, agentType);
  if ((agentType === 'claude' && currentSessionId) || (agentType !== 'claude' && !currentSessionId)) {
    void adoptExistingSessionForTerminal(entry, rootDirs);
    scheduleAdoptionRetry(terminal, entry, rootDirs);
  }
}
