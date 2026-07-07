// Machine-wide session-file watcher for the leader (#69).
//
// The elected monitor mounts exactly ONE recursive fs.watch per session root
// (~/.claude/projects + version dirs, ~/.codex/sessions, ~/.gemini/tmp,
// opencode storage/session) for the whole machine — replacing the per-window,
// per-terminal fs.watch + fs.watchFile poll that `sessionTracker` runs today.
// It parses the head of each new/changed session file (sessionParse.ts) and
// emits a fact carrying the same correlation metadata sessionTracker reads, so
// each follower runs the identical window-local correlation against its own
// terminals.
//
// vscode-free: pure fs + the shared parser, driven by the host — runs and tests
// in a plain process against real files.

import * as fs from 'fs';
import * as path from 'path';
import {
  SessionFactPayload,
  SessionWarmthPayload,
} from './protocol';
import {
  WatcherRoot,
  isSessionFilename,
  parseSessionHead,
  sessionIdFromFile,
  watcherRoots,
} from './sessionParse';

const DEFAULT_DEBOUNCE_MS = 300;

export interface SessionWatcherOptions {
  emit: (fact: SessionFactPayload) => void;
  /** Warmth signal: a tracked session file was written (kill/restart clock). */
  emitWarmth: (fact: SessionWarmthPayload) => void;
  /** Override the watched roots (tests). Defaults to watcherRoots(). */
  roots?: WatcherRoot[];
  debounceMs?: number;
}

interface MountedWatcher {
  watcher: fs.FSWatcher;
  root: string;
  agentType: SessionFactPayload['agentType'];
}

export class SessionWatcher {
  private readonly emit: (fact: SessionFactPayload) => void;
  private readonly emitWarmth: (fact: SessionWarmthPayload) => void;
  private readonly roots: WatcherRoot[];
  private readonly debounceMs: number;
  private readonly mounted: MountedWatcher[] = [];
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(options: SessionWatcherOptions) {
    this.emit = options.emit;
    this.emitWarmth = options.emitWarmth;
    this.roots = options.roots ?? watcherRoots();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** Number of roots with a live fs.watch (for `lsof`-style verification/tests). */
  get watchedRootCount(): number {
    return this.mounted.length;
  }

  /** Mount one recursive fs.watch per root. Roots that don't exist are skipped. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const { root, agentType } of this.roots) {
      if (!ensureDirExists(root)) continue;
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(root, { recursive: true }, (event, filename) => {
          if (!filename) return;
          this.onEvent(root, agentType, event, filename.toString());
        });
      } catch {
        continue; // some platforms reject recursive watch — skip the root
      }
      this.mounted.push({ watcher, root, agentType });
    }
  }

  stop(): void {
    this.started = false;
    for (const m of this.mounted) {
      try {
        m.watcher.close();
      } catch {
        /* ignore */
      }
    }
    this.mounted.length = 0;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }

  private onEvent(
    root: string,
    agentType: SessionFactPayload['agentType'],
    event: string,
    relative: string,
  ): void {
    const base = path.basename(relative);
    if (!isSessionFilename(base, agentType)) return;
    const full = path.join(root, relative);

    // Warmth is recorded immediately on every write so a follower's dormancy
    // clock for its tracked file stays accurate (mirrors recordWrite).
    if (event === 'change') {
      this.emitWarmth({ filePath: full, ts: Date.now() });
    }

    const existing = this.debounceTimers.get(full);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(full);
      void this.parseAndEmit(full, agentType).catch(() => {});
    }, this.debounceMs);
    this.debounceTimers.set(full, timer);
  }

  private async parseAndEmit(
    filePath: string,
    agentType: SessionFactPayload['agentType'],
  ): Promise<void> {
    let mtimeMs = Date.now();
    try {
      const stat = await fs.promises.stat(filePath);
      mtimeMs = stat.mtimeMs;
    } catch {
      return; // file vanished between event and parse
    }
    const parsed = await parseSessionHead(filePath, agentType);
    this.emit({
      agentType,
      filePath,
      fileSessionId: sessionIdFromFile(filePath),
      mtimeMs,
      forkedFromId: parsed.forkedFromId,
      codexCwd: parsed.codexCwd,
      geminiProjectHash: parsed.geminiProjectHash,
      geminiSessionId: parsed.geminiSessionId,
      opencodeDirectory: parsed.opencodeDirectory,
      opencodeSessionId: parsed.opencodeSessionId,
    });
  }
}

function ensureDirExists(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return fs.existsSync(dir);
  }
}
