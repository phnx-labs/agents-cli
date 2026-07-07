// Shared cross-window registry of live agent terminals.
//
// Each VS Code / Codium / Cursor window runs its own extension host, so
// `vscode.window.terminals` only tells us what's open in THIS window. The
// foreman needs to see every agent across every IDE window. We solve that
// by having each extension host write its own terminals to a shared JSON
// file; readers merge entries and filter out ones whose pid is dead.
//
// File: ~/.agents/.cache/terminals/live-terminals.json
// Shape: { <windowId>: { at: ISO, entries: LiveTerminal[] } }
//   - Writer owns its windowId slice. Reads are merges of all slices.
//   - Stale entries (pid dead) are filtered at read time, not pruned. The
//     owning window prunes on its own terminal close/exit events.
//   - If a whole window crashed, its slice is dropped when `at` is older
//     than 10 minutes AND any entry's pid is dead.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { computeWindowId } from '../core/foreman.windowId';
import { isPidAlive } from '../core/liveness';
import { resolveTabIndex, type TabView } from '../core/tabIndex';
import { getTmuxInfo } from './tmux';

const REGISTRY_DIR = path.join(os.homedir(), '.agents', '.cache', 'terminals');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'live-terminals.json');
const LEGACY_REGISTRY_FILE = path.join(os.homedir(), '.agents', 'swarmify', 'live-terminals.json');
const STALE_WINDOW_MS = 10 * 60_000;
// Force a write at least this often even when our slice is unchanged, so
// peers don't prune us as crashed (peer prune trigger: `at` older than
// STALE_WINDOW_MS AND every pid in our slice is dead).
const KEEPALIVE_FORCE_MS = 4 * 60_000;

export interface LiveTerminal {
  sessionId: string;
  pid: number;
  kind: string;              // 'claude' | 'codex' | 'gemini' | ...
  label?: string | null;
  cwd?: string | null;
  startedAtMs: number;
  // Richer tracking so the CLI can address + display this terminal precisely.
  // DATA CONTRACT with the CLI (src/lib/session): field names are load-bearing.
  tmuxSession?: string;      // tmux session name when the agent runs inside tmux.
  tmuxPane?: string;         // tmux `%N` pane id (unique addressing) when known.
  tabIndex?: number;         // 1-based editor-tab index within its group ("Codium tab N").
}

interface RegistryFile {
  [windowId: string]: { at: string; entries: LiveTerminal[] };
}

let ownWindowId: string | undefined;
function getOwnWindowId(): string {
  if (ownWindowId) return ownWindowId;
  // VSCodium strips telemetry and replaces vscode.env.sessionId with the
  // literal "someValue.sessionId" for every window — sessionId alone collides
  // across windows. process.pid is per-extension-host so it disambiguates.
  ownWindowId = computeWindowId(vscode.env.sessionId, process.pid);
  return ownWindowId;
}

async function readRegistryAsync(): Promise<RegistryFile> {
  try {
    const raw = await fs.promises.readFile(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    try {
      const raw = await fs.promises.readFile(LEGACY_REGISTRY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}

function readRegistry(): RegistryFile {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    try {
      const raw = fs.readFileSync(LEGACY_REGISTRY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}

async function writeRegistryAsync(reg: RegistryFile): Promise<void> {
  try {
    await fs.promises.mkdir(REGISTRY_DIR, { recursive: true });
    const tmp = `${REGISTRY_FILE}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, JSON.stringify(reg, null, 2));
    await fs.promises.rename(tmp, REGISTRY_FILE);
  } catch {
    /* best effort */
  }
}

let lastPublishedHash: string | undefined;
let lastPublishedAtMs = 0;

function hashEntries(entries: LiveTerminal[]): string {
  // Stable hash of the slice content (sessionId+pid+kind+label+cwd). The
  // `at` timestamp is excluded — it changes every call and would make every
  // hash unique.
  const stable = entries
    .map((e) => `${e.sessionId}|${e.pid}|${e.kind}|${e.label ?? ''}|${e.cwd ?? ''}|${e.tmuxPane ?? ''}|${e.tabIndex ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha1').update(stable).digest('hex');
}

// Publish this window's live terminals. Skips the disk write when our slice
// is unchanged AND a keepalive isn't due — the previous implementation did
// a sync read+write of the whole registry on every terminal event AND on a
// 15s interval, blocking the extension-host thread for no information gain.
export async function publishLiveTerminals(terminals: LiveTerminal[]): Promise<void> {
  const hash = hashEntries(terminals);
  const now = Date.now();
  const unchanged = hash === lastPublishedHash;
  const keepaliveDue = now - lastPublishedAtMs >= KEEPALIVE_FORCE_MS;
  if (unchanged && !keepaliveDue) return;

  const reg = await readRegistryAsync();
  reg[getOwnWindowId()] = {
    at: new Date().toISOString(),
    entries: terminals,
  };
  // Garbage-collect peer slices that look crashed (old timestamp + all pids dead).
  const cutoff = now - STALE_WINDOW_MS;
  for (const [winId, slice] of Object.entries(reg)) {
    if (winId === getOwnWindowId()) continue;
    const at = Date.parse(slice?.at ?? '');
    if (!Number.isFinite(at) || at > cutoff) continue;
    const anyAlive = (slice.entries ?? []).some((e) => isPidAlive(e.pid));
    if (!anyAlive) delete reg[winId];
  }
  await writeRegistryAsync(reg);
  lastPublishedHash = hash;
  lastPublishedAtMs = now;
}

// Read all live terminals across every IDE window, filtered to pid-alive only.
// Deduped by sessionId - the self-window entries take precedence over peer ones.
export function readLiveTerminals(): LiveTerminal[] {
  const reg = readRegistry();
  const selfId = getOwnWindowId();
  const selfSlice = reg[selfId]?.entries ?? [];
  const peerSlices = Object.entries(reg)
    .filter(([id]) => id !== selfId)
    .flatMap(([, v]) => v?.entries ?? []);

  const merged = new Map<string, LiveTerminal>();
  // Peers first, self overwrites.
  for (const t of peerSlices) {
    if (!t?.sessionId || !isPidAlive(t.pid)) continue;
    merged.set(t.sessionId, t);
  }
  for (const t of selfSlice) {
    if (!t?.sessionId || !isPidAlive(t.pid)) continue;
    merged.set(t.sessionId, t);
  }
  return Array.from(merged.values());
}

// Scan vscode.window.terminals and build a LiveTerminal array for this window.
// Returns [] if no agent terminals are open here.
export async function snapshotOwnTerminals(): Promise<LiveTerminal[]> {
  const out: LiveTerminal[] = [];
  // Flatten the editor tab groups ONCE per snapshot so resolveTabIndex is a pure
  // lookup per terminal rather than re-walking the tab tree each time.
  const tabGroups: TabView[][] = vscode.window.tabGroups.all.map((g) =>
    g.tabs.map((tab) => ({
      label: tab.label,
      isTerminal: tab.input instanceof vscode.TabInputTerminal,
    })),
  );
  for (const t of vscode.window.terminals) {
    if (t.exitStatus !== undefined) continue;
    const opts = t.creationOptions as vscode.TerminalOptions;
    const env = opts?.env as Record<string, string | undefined> | undefined;
    const sid = env?.AGENT_SESSION_ID;
    const tid = env?.AGENT_TERMINAL_ID;
    if (!sid) continue;
    const pid = await t.processId;
    if (!pid) continue;
    const kind = tid ? kindFromTerminalId(tid) : kindFromName(t.name);
    // tmux coordinates (session + %pane) when this terminal was spawned inside
    // tmux; undefined for the native path. Best-effort pane read off the socket.
    const tmux = await getTmuxInfo(t);
    // Editor-tab position, matched by the terminal's name against its tab label.
    const tabIndex = resolveTabIndex(tabGroups, t.name);
    out.push({
      sessionId: sid,
      pid,
      kind,
      label: deriveLabel(t.name),
      cwd: env?.AGENT_WORKSPACE_DIR ?? null,
      startedAtMs: Date.now(),
      tmuxSession: tmux?.session,
      tmuxPane: tmux?.pane,
      tabIndex,
    });
  }
  return out;
}

function kindFromTerminalId(terminalId: string): string {
  const prefix = terminalId.split('-')[0]?.toUpperCase() ?? '';
  switch (prefix) {
    case 'CC': case 'CL': return 'claude';
    case 'CX': return 'codex';
    case 'GX': return 'gemini';
    case 'OC': return 'opencode';
    case 'CR': return 'cursor';
    case 'CP': return 'copilot';
    case 'SH': return 'shell';
    default: return prefix.toLowerCase() || 'unknown';
  }
}

function kindFromName(name: string): string {
  const head = name.trim().split(/\s+|-/)[0]?.toLowerCase() ?? '';
  if (['claude', 'cc'].includes(head)) return 'claude';
  if (['codex', 'cx'].includes(head)) return 'codex';
  if (['gemini', 'gx'].includes(head)) return 'gemini';
  if (['opencode', 'oc'].includes(head)) return 'opencode';
  if (['cursor', 'cr'].includes(head)) return 'cursor';
  if (['copilot', 'cp'].includes(head)) return 'copilot';
  return head || 'unknown';
}

function deriveLabel(name: string): string | null {
  const m = name.match(/-\s+(.+)$/);
  return m ? m[1].trim() : null;
}
