import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  BrowserCdpConnectionError,
  CDPClient,
  discoverBrowserWsUrl,
  verifyBrowserIdentity,
} from './cdp.js';
import {
  getProfile,
  getProfileRuntimeDir,
  getBrowserRuntimeDir,
  listProfiles,
  extractConfiguredPort,
  resolveEndpoint,
} from './profiles.js';
import { killChrome, getRunningChromeInfo, launchBrowser, allocatePort } from './chrome.js';
import { connectLocal } from './drivers/local.js';
import { connectSSH, shellQuote } from './drivers/ssh.js';
import { clearProfileRuntime } from './runtime-state.js';
import { resolveDomainSkill, type ResolvedDomainSkill } from './domain-skills.js';
import {
  generateTaskId,
  generateShortId,
  generateTaskName,
  isValidTaskId,
  type Task,
  type TabInfo,
  type ProfileStatus,
  type TaskStatus,
  type BrowserProfile,
  type HistoricalTask,
} from './types.js';
import { getRefs, resolveRefToCoords, describeRefs, healRef, type RefOpts, type RefNode, type RefSnapshot } from './refs.js';
import { clickAtCoords, hoverAtCoords, scrollAtCoords, typeText, pressKey, focusNode } from './input.js';
import { typeEditorText } from './editor.js';
import {
  detectUploadPattern,
  stageUploadFile,
  uploadToDropTarget,
  uploadToFileInput,
  uploadViaFileChooser,
} from './upload.js';
import { emit } from '../events.js';
import type { TargetFilter } from './types.js';

export type UploadMode = 'auto' | 'input' | 'drop' | 'chooser';

function isPathInside(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveScreenshotOutputPath(outputPath: string | undefined, automaticPath: string): string {
  if (!outputPath) return automaticPath;

  const runtimeDir = getBrowserRuntimeDir();
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeReal = fs.realpathSync(runtimeDir);
  const requested = path.resolve(outputPath);
  const parent = path.dirname(requested);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  const resolved = path.join(parentReal, path.basename(requested));
  if (!isPathInside(resolved, runtimeReal)) {
    return automaticPath;
  }
  return resolved;
}

/**
 * Read width/height from a JPEG buffer by walking SOF markers. Returns null
 * if the buffer doesn't start with the JPEG SOI marker or no SOF segment is
 * found. We use this on every screenshot so the CLI can surface the actual
 * captured pixel dimensions (which differ from viewport size at non-1x DPR).
 */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG signature (8 bytes) + IHDR chunk: length (4) + 'IHDR' (4) + width (4) + height (4)
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    // SOF0–SOFn carry dimensions, except DHT (0xC4), JPG (0xC8), DAC (0xCC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Parse a `targetFilter` string into its kind + value, or return `null`
 * when the input is missing or malformed. Filter syntax:
 *   - `url:<substring>`   — picks the first page target whose URL contains the substring
 *   - `title:<substring>` — picks the first page target whose title contains the substring
 *
 * The match is case-insensitive on both sides because Electron apps
 * frequently lowercase or title-case their target metadata in unpredictable ways.
 */
export function parseTargetFilter(filter: string | undefined): TargetFilter | null {
  if (!filter) return null;
  const idx = filter.indexOf(':');
  if (idx <= 0) return null;
  const kind = filter.slice(0, idx).trim().toLowerCase();
  // Strip whitespace around the value so `url: https://x` (with a copy-pasted
  // space after the colon) doesn't silently fail to match — `.includes(' x')`
  // never hits a URL because URLs don't contain spaces.
  const value = filter.slice(idx + 1).trim();
  if (kind !== 'url' && kind !== 'title') return null;
  if (!value) return null;
  return { kind, value };
}

/**
 * URLs that the skip-invisible heuristic excludes when no explicit filter
 * matches. These are page targets Electron apps ship for housekeeping;
 * picking one means screenshots come back blank.
 */
const INVISIBLE_URL_PATTERNS: RegExp[] = [
  /^about:blank$/i,
  /^file:\/\//i,
  /\/_desktop-background-service(\?|$|\/)/i,
  /\/_internal(\?|$|\/)/i,
  /\/_background(\?|$|\/)/i,
];

function isLikelyInvisible(url: string | undefined): boolean {
  if (!url) return true;
  return INVISIBLE_URL_PATTERNS.some((re) => re.test(url));
}

/**
 * Choose the CDP page target that represents the visible UI.
 *
 * Order:
 *   1. If `filter` is set and parseable, narrow to page targets matching it
 *      (case-insensitive substring). Among matches, prefer one that is not in
 *      `INVISIBLE_URL_PATTERNS` — this is the tiebreaker that makes a coarse
 *      filter like `url:https://www.canva.com/` skip the background service
 *      (`https://www.canva.com/_desktop-background-service` *also* matches the
 *      substring). If every match is invisible, return the first match so the
 *      caller still gets something rather than silently falling through.
 *      An explicit filter that finds *no* match returns `undefined` — callers
 *      should surface this as an error rather than create an orphan window.
 *   2. If `filter` is unset (or unparseable), apply the skip-invisible heuristic
 *      across all page targets.
 *   3. As a last resort, return the first page target.
 */
export function pickWindowTarget<T extends { type: string; url?: string; title?: string }>(
  targets: T[],
  filter: string | undefined
): T | undefined {
  const pages = targets.filter((t) => t.type === 'page');
  if (pages.length === 0) return undefined;

  const parsed = parseTargetFilter(filter);
  if (parsed) {
    const needle = parsed.value.toLowerCase();
    const matches = pages.filter((t) => {
      const hay = (parsed.kind === 'url' ? t.url : t.title) ?? '';
      return hay.toLowerCase().includes(needle);
    });
    if (matches.length === 0) return undefined;
    const visible = matches.find((t) => !isLikelyInvisible(t.url));
    return visible ?? matches[0];
  }

  const visible = pages.find((t) => !isLikelyInvisible(t.url));
  if (visible) return visible;

  return pages[0];
}

const execFileP = promisify(execFile);

/**
 * Parse a `--since`/`--until` value. Accepts ISO-8601 absolute timestamps
 * or relative offsets like `30s`, `5m`, `2h`, `1d`.
 */
export function parseSinceUntil(s: string): Date {
  const ms = Date.parse(s);
  if (!isNaN(ms)) return new Date(ms);
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`Invalid since/until: ${s}`);
  const n = parseInt(m[1], 10);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() - n * unitMs[m[2]]);
}

async function execSSH(host: string, cmd: string): Promise<string> {
  const { stdout } = await execFileP('ssh', [host, cmd], {
    timeout: 10_000,
    maxBuffer: 10_000_000,
  });
  return stdout;
}

export function readNewestMatchingRemoteFileCommand(
  dir: string,
  prefix: string,
  tailLines: number
): string {
  const glob = `${shellQuote(dir)}/${prefix}*.jsonl`;
  return `latest=$(ls -1t ${glob} 2>/dev/null | head -1); if [ -n "$latest" ]; then tail -n ${tailLines} "$latest"; fi`;
}

export function readNewestMatchingFile(dir: string, prefix: string, tailLines: number): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return '';
  }
  const candidates = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return '';
  const lines = fs
    .readFileSync(path.join(dir, candidates[0].f), 'utf8')
    .split('\n')
    .filter(Boolean);
  return lines.slice(-tailLines).join('\n');
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}


/**
 * Probe a cached connection before reuse. A WebSocket can quietly transition
 * to CLOSED without anyone noticing — most commonly when the user kills the
 * browser process by hand. `Browser.getVersion` is the lightest CDP call we
 * can make; if it doesn't round-trip within 1s the connection is dead.
 */
async function isConnHealthy(conn: ProfileConnection, timeoutMs = 1000): Promise<boolean> {
  if (!conn.cdp.isOpen) return false;
  try {
    await Promise.race([
      conn.cdp.send('Browser.getVersion'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('healthcheck timeout')), timeoutMs)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

interface ProfileConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
  electron?: boolean;
  /** Raw `url:<v>` / `title:<v>` filter copied from the profile config. */
  targetFilter?: string;
  forkedFrom?: string;
  tasks: Map<string, Task>;
  windowId?: string; // single window shared by all tasks
  targetCache?: { targets: TargetInfo[]; ts: number };
  sessionCache: Map<string, string>;
  /**
   * Connection-specific teardown (e.g. killing the SSH tunnel for an ssh://
   * profile). Must be called whenever the connection is removed from
   * `this.connections`, otherwise the tunnel leaks across daemon restarts
   * and hijacks future `cdp://127.0.0.1:N` profiles on the same local port.
   */
  cleanup?: () => void;
}

type TargetInfo = {
  targetId: string;
  url?: string;
  title?: string;
};

/** Describes a ref that was re-resolved from a drifted integer via its cached descriptor. */
export interface HealInfo {
  from: number;
  to: number;
  role: string;
  name: string;
}

export class BrowserService {
  private static readonly SOURCE_PREFIX: Record<string, string> = {
    'rush-app': 'rush-app-',
    'rush-cli': 'rush-cli-',
  };

  private connections = new Map<string, ProfileConnection>();
  private forkingProfiles = new Set<string>();

  // Per-task storage for console, errors, network, downloads
  private consoleLogs = new Map<string, import('./types.js').ConsoleEntry[]>();
  private pageErrors = new Map<string, import('./types.js').ErrorEntry[]>();
  private networkRequests = new Map<string, import('./types.js').NetworkRequest[]>();
  private pendingDownloads = new Map<string, { path: string; filename?: string; completed: boolean }>();
  private enabledSessions = new Map<string, Set<string>>(); // sessionId -> enabled domains

  async start(
    profileName: string,
    opts: { taskName?: string; url?: string; endpointName?: string; skipDomainSkill?: boolean } = {}
  ): Promise<{ task: string; name: string; tabId?: string; windowId?: string; profile: string; skill?: ResolvedDomainSkill }> {
    const profile = await getProfile(profileName);
    if (!profile) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    // Pick the endpoint preset. Throws with the candidate list if the user
    // passed an unknown name. The composite identifier `<profile>@<endpoint>`
    // is what the connection map + per-profile runtime dirs are keyed on, so
    // a single YAML profile can run at multiple endpoints concurrently.
    const resolved = resolveEndpoint(profile, opts.endpointName);
    const composite = `${profileName}@${resolved.name}`;
    const effectiveProfile: BrowserProfile = {
      ...profile,
      name: composite,
      binary: resolved.binary,
      targetFilter: resolved.targetFilter,
    };

    let taskName: string;
    if (opts.taskName) {
      if (this.hasTaskNamed(opts.taskName)) {
        throw new Error(
          `Task "${opts.taskName}" already exists. Pick a different --task name or stop the existing one first.`
        );
      }
      taskName = opts.taskName;
    } else {
      taskName = this.generateUniqueTaskName();
    }
    const taskId = generateTaskId();

    let conn = this.connections.get(composite);
    let effectiveProfileName = composite;

    // If we have a cached connection, confirm it's still usable before any
    // caller relies on it. A browser killed externally (Cmd-Q, crash, or a
    // user clearing the profile by hand) leaves a closed WebSocket here.
    // Without this check the next `cdp.send` throws "CDP connection not
    // open" and the user has no way to recover short of killing the daemon.
    if (conn && !(await isConnHealthy(conn))) {
      try { conn.cdp.close(); } catch { /* already closed */ }
      conn.cleanup?.();
      this.connections.delete(composite);
      conn = undefined;
    }

    if (conn && conn.electron && conn.tasks.size > 0) {
      if (this.forkingProfiles.has(composite)) {
        while (this.forkingProfiles.has(composite)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const existingFork = this.findAvailableFork(composite);
        if (existingFork) {
          conn = existingFork.conn;
          effectiveProfileName = existingFork.name;
        } else {
          throw new Error(`Fork in progress but no available fork found for "${composite}"`);
        }
      } else {
        this.forkingProfiles.add(composite);
        try {
          const { forkName, connection } = await this.forkElectronProfile(effectiveProfile);
          conn = connection;
          effectiveProfileName = forkName;
        } finally {
          this.forkingProfiles.delete(composite);
        }
      }
    } else if (!conn) {
      conn = await this.connectProfile(effectiveProfile, resolved.target);
      this.connections.set(composite, conn);
    }

    const task: Task = {
      id: taskId,
      name: taskName,
      profile: effectiveProfileName,
      tabs: {},
      currentTabId: undefined,
      createdAt: Date.now(),
      pid: conn.pid,
    };

    // For Electron, get the existing window as the tab
    if (conn.electron) {
      const windowId = await this.getOrCreateWindow(conn);
      if (windowId) {
        const shortId = generateShortId();
        task.tabs[shortId] = windowId;
        task.currentTabId = shortId;
      }
    }

    conn.tasks.set(taskName, task);
    await this.saveTaskState(effectiveProfileName, conn.tasks);

    emit('browser.launch', { profile: effectiveProfileName, task: taskName, pid: conn.pid });

    // If URL provided, create tab directly (no about:blank)
    let tabId: string | undefined;
    if (opts.url && !conn.electron) {
      const result = (await conn.cdp.send('Target.createTarget', {
        url: opts.url,
      })) as { targetId: string };
      const shortId = generateShortId();
      task.tabs[shortId] = result.targetId;
      task.currentTabId = shortId;
      this.invalidateTargetCache(conn);
      await this.saveTaskState(effectiveProfileName, conn.tasks);
      tabId = shortId;
    } else if (opts.url && conn.electron) {
      const result = await this.navigate(taskName, opts.url, effectiveProfileName);
      tabId = result.tabId;
    }

    // Domain-skill discovery: when a URL is supplied, look up site-specific
    // operating instructions and pass them back so the calling agent can pick
    // them up alongside the task id. Failures swallowed by resolveDomainSkill.
    let skill: ResolvedDomainSkill | undefined;
    if (opts.url && !opts.skipDomainSkill) {
      const resolved = resolveDomainSkill(opts.url);
      if (resolved) skill = resolved;
    }

    return { task: taskId, name: taskName, tabId, profile: effectiveProfileName, skill };
  }

  async stop(taskName: string): Promise<{ ok: boolean; profile?: string }> {
    for (const [profileName, conn] of this.connections) {
      const task = conn.tasks.get(taskName);
      if (task) {
        // Get domains from tabs before closing (for history)
        const domains = new Set<string>();
        try {
          const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
            targetInfos: Array<{ targetId: string; url: string }>;
          };
          for (const cdpId of Object.values(task.tabs)) {
            const target = targetInfos.find((t) => t.targetId === cdpId);
            if (target?.url) {
              try {
                const domain = new URL(target.url).hostname.replace(/^www\./, '');
                if (domain && domain !== 'blank') domains.add(domain);
              } catch {
                // invalid URL
              }
            }
          }
        } catch {
          // CDP not responding
        }

        // Save to history before closing
        await this.saveToHistory(task, Array.from(domains));

        // Close task's tabs (not the window - it's shared)
        await Promise.all(
          Object.values(task.tabs).map((cdpId) =>
            conn.cdp.send('Target.closeTarget', { targetId: cdpId }).catch(() => {
              // Tab already closed
            })
          )
        );
        for (const cdpId of Object.values(task.tabs)) {
          conn.sessionCache.delete(cdpId);
        }
        this.invalidateTargetCache(conn);

        conn.tasks.delete(taskName);
        await this.saveTaskState(profileName, conn.tasks);

        emit('browser.close', { profile: profileName, task: taskName });

        if (conn.forkedFrom && conn.tasks.size === 0) {
          conn.cdp.close();
          killChrome(conn.pid);
          conn.cleanup?.();
          this.connections.delete(profileName);
        }

        return { ok: true, profile: profileName };
      }
    }

    return { ok: false };
  }

  async done(taskName: string): Promise<{ ok: boolean; profile?: string }> {
    return this.stop(taskName);
  }

  async stopProfile(profileName: string): Promise<void> {
    // Connections are keyed by the composite `<profile>@<endpoint>` (see start()),
    // but callers pass the bare profile name (or, occasionally, an exact composite).
    // A plain `connections.get(profileName)` therefore missed every real remote
    // connection, so `cleanup()` never ran — leaving the SSH tunnel and, on
    // Windows, the WMI-spawned browser orphaned on the remote host after every
    // `browser stop --profile` (#559). Match the exact key AND every
    // `<profileName>@<endpoint>` composite so all of a profile's live connections
    // are torn down.
    const keys = [...this.connections.keys()].filter(
      (k) => k === profileName || k.startsWith(`${profileName}@`)
    );
    for (const key of keys) {
      const conn = this.connections.get(key);
      if (!conn) continue;
      conn.cdp.close();
      killChrome(conn.pid);
      conn.cleanup?.();
      this.connections.delete(key);
    }

    const runtimeDir = getProfileRuntimeDir(profileName);
    const pidFile = path.join(runtimeDir, 'pid');
    const portFile = path.join(runtimeDir, 'port');

    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      killChrome(pid);
      fs.unlinkSync(pidFile);
    }
    if (fs.existsSync(portFile)) {
      fs.unlinkSync(portFile);
    }
  }

  async navigate(
    taskId: string,
    url: string,
    profileName?: string
  ): Promise<{ tabId: string; url: string; created: boolean }> {
    const { conn, task } = await this.findTask(taskId, profileName);

    // If we have a current tab, navigate in it (reuse)
    const currentShortId = task.currentTabId;
    if (currentShortId && task.tabs[currentShortId]) {
      const cdpTargetId = task.tabs[currentShortId];
      const sessionId = await this.getSessionId(conn, cdpTargetId);
      await conn.cdp.send('Page.navigate', { url }, sessionId);
      await this.saveTaskState(task.profile, conn.tasks);
      return { tabId: currentShortId, url, created: false };
    }

    // No current tab - create one
    if (conn.electron) {
      const cdpTargetId = conn.windowId;
      if (!cdpTargetId) {
        throw new Error('No existing tab to navigate in Electron app');
      }
      const shortId = generateShortId();
      const sessionId = await this.getSessionId(conn, cdpTargetId);
      await conn.cdp.send('Page.navigate', { url }, sessionId);
      task.tabs[shortId] = cdpTargetId;
      task.currentTabId = shortId;
      await this.saveTaskState(task.profile, conn.tasks);
      return { tabId: shortId, url, created: true };
    }

    // Chrome: create new tab
    const result = (await conn.cdp.send('Target.createTarget', {
      url,
    })) as { targetId: string };

    const shortId = generateShortId();
    task.tabs[shortId] = result.targetId;
    task.currentTabId = shortId;
    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);

    return { tabId: shortId, url, created: true };
  }

  async tabAdd(
    taskId: string,
    url: string,
    profileName?: string
  ): Promise<{ tabId: string; url: string }> {
    const { conn, task } = await this.findTask(taskId, profileName);

    if (conn.electron) {
      throw new Error('Electron apps do not support opening additional tabs');
    }

    const result = (await conn.cdp.send('Target.createTarget', {
      url,
    })) as { targetId: string };

    const shortId = generateShortId();
    task.tabs[shortId] = result.targetId;
    task.currentTabId = shortId; // new tab becomes current
    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);

    return { tabId: shortId, url };
  }

  async tabFocus(taskId: string, tabHint: string): Promise<{ tabId: string }> {
    const { conn, task } = await this.findTask(taskId);
    const resolvedTabId = await this.resolveTabHint(conn, task, tabHint);
    task.currentTabId = resolvedTabId;
    await this.saveTaskState(task.profile, conn.tasks);
    return { tabId: resolvedTabId };
  }

  async tabList(taskId: string): Promise<Array<{ id: string; url: string; title: string; current: boolean }>> {
    const { conn, task } = await this.findTask(taskId);
    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string; title: string }>;
    };

    const tabs: Array<{ id: string; url: string; title: string; current: boolean }> = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target) {
        tabs.push({
          id: shortId,
          url: target.url,
          title: target.title,
          current: shortId === task.currentTabId,
        });
      }
    }
    return tabs;
  }

  private async resolveTabHint(conn: ProfileConnection, task: Task, hint: string): Promise<string> {
    // Exact match
    if (task.tabs[hint]) return hint;

    // Prefix match
    const byPrefix = Object.keys(task.tabs).filter((id) => id.startsWith(hint));
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) {
      throw new Error(`Ambiguous tab hint "${hint}" — matches ${byPrefix.length} tabs`);
    }

    // URL substring match
    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string }>;
    };
    const matches: string[] = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target && target.url.includes(hint)) {
        matches.push(shortId);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous tab hint "${hint}" — matches ${matches.length} tabs by URL`);
    }

    throw new Error(`Tab "${hint}" not found`);
  }

  private resolveCurrentTab(task: Task): string {
    const tabIds = Object.keys(task.tabs);
    const id = task.currentTabId ?? tabIds[tabIds.length - 1];
    if (!id) throw new Error('No tabs open for this task');
    return id;
  }

  private getCdpTargetId(task: Task, shortId: string): string {
    const cdpId = task.tabs[shortId];
    if (!cdpId) throw new Error(`Tab ${shortId} not found`);
    return cdpId;
  }

  async tabs(taskId?: string, profileName?: string): Promise<TabInfo[]> {
    if (taskId) {
      const { conn, task } = await this.findTask(taskId, profileName);
      return this.getTabsForTask(conn.cdp, task);
    }

    const allTabs: TabInfo[] = [];
    for (const [, conn] of this.connections) {
      for (const [, task] of conn.tasks) {
        const tabs = await this.getTabsForTask(conn.cdp, task);
        allTabs.push(...tabs);
      }
    }
    return allTabs;
  }

  async tabClose(taskId: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);

    if (tabHint !== undefined) {
      const shortId = await this.resolveTabHint(conn, task, tabHint);
      const cdpId = task.tabs[shortId];
      if (cdpId) {
        await conn.cdp.send('Target.closeTarget', { targetId: cdpId });
        conn.sessionCache.delete(cdpId);
        delete task.tabs[shortId];
        // Update currentTabId if we closed the current tab
        if (task.currentTabId === shortId) {
          const remaining = Object.keys(task.tabs);
          task.currentTabId = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
        }
      }
    } else {
      // Close all tabs
      await Promise.all(
        Object.values(task.tabs).map((cdpId) =>
          conn.cdp.send('Target.closeTarget', { targetId: cdpId }).catch(() => {})
        )
      );
      for (const cdpId of Object.values(task.tabs)) {
        conn.sessionCache.delete(cdpId);
      }
      task.tabs = {};
      task.currentTabId = undefined;
    }

    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);
  }

  async evaluate(
    taskId: string,
    tabHint: string | undefined,
    expression: string
  ): Promise<unknown> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    // `awaitPromise: true` lets callers write `evaluate '(async () => {...})()'`
    // and get the resolved value back instead of a stringified Promise. This
    // is essential for any flow that needs sub-step waits inside the page
    // (e.g. driving a multi-step modal where each step needs React to settle
    // before the next call). Without it, the shell-side workaround is to
    // chain N separate `evaluate` calls with `sleep` between them, which
    // races against the page's own state machine.
    //
    // `exceptionDetails` is surfaced as a thrown error so a rejected promise
    // or a thrown error inside the expression doesn't silently return `undefined`.
    const result = (await conn.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    )) as {
      result: { value: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
    };

    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      const msg =
        ex.exception?.description ??
        (typeof ex.exception?.value === 'string' ? ex.exception.value : undefined) ??
        ex.text ??
        'evaluate failed';
      throw new Error(msg);
    }

    return result.result.value;
  }

  async screenshot(
    taskId: string,
    tabHint?: string,
    outputPath?: string,
    quality: 'compressed' | 'raw' = 'compressed'
  ): Promise<{ path: string; bytes: number; width: number; height: number }> {
    const { conn, task } = await this.findTask(taskId);

    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    let buffer: Buffer;
    let extension: string;

    if (quality === 'raw') {
      // Pixel-faithful PNG, no downscale. For archived QA evidence where
      // lossy JPEG would hide rendering bugs. Files run 0.5–3 MB.
      const { data } = (await conn.cdp.send(
        'Page.captureScreenshot',
        { format: 'png' },
        sessionId
      )) as { data: string };
      buffer = Buffer.from(data, 'base64');
      extension = 'png';
    } else {
      // Default: JPEG quality 70, then iteratively downscale to keep the
      // file under 100 KB so chat-injected screenshots stay token-cheap.
      const { data } = (await conn.cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 70 },
        sessionId
      )) as { data: string };
      buffer = Buffer.from(data, 'base64');

      const MAX_SIZE = 100 * 1024;
      if (buffer.length > MAX_SIZE) {
        let q = 50;
        while (buffer.length > MAX_SIZE && q > 10) {
          const { data: resized } = (await conn.cdp.send(
            'Page.captureScreenshot',
            { format: 'jpeg', quality: q },
            sessionId
          )) as { data: string };
          buffer = Buffer.from(resized, 'base64');
          q -= 10;
        }
      }
      extension = 'jpg';
    }

    const sessionsDir = path.join(getBrowserRuntimeDir(), 'sessions', task.name);
    const automaticPath = path.join(sessionsDir, `${Date.now()}.${extension}`);
    const finalPath = resolveScreenshotOutputPath(outputPath, automaticPath);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(finalPath, buffer);

    const dims =
      (extension === 'png' ? readPngDimensions(buffer) : readJpegDimensions(buffer)) ??
      { width: 0, height: 0 };
    return { path: finalPath, bytes: buffer.length, width: dims.width, height: dims.height };
  }

  /**
   * Export the current tab as a PDF via CDP `Page.printToPDF`. Reuses the
   * screenshot session + tab resolution so `--tab`, path sandboxing, and the
   * auto-path (`sessions/<task>/<ts>.pdf`) all behave identically to
   * `screenshot`. `printBackground: true` matches Chrome's default print flow
   * — without it, dark-mode pages render on a blank sheet.
   */
  async printToPdf(
    taskId: string,
    tabHint?: string,
    outputPath?: string
  ): Promise<{ path: string; bytes: number }> {
    const { conn, task } = await this.findTask(taskId);

    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    const { data } = (await conn.cdp.send(
      'Page.printToPDF',
      { printBackground: true, preferCSSPageSize: true },
      sessionId
    )) as { data: string };
    const buffer = Buffer.from(data, 'base64');

    const sessionsDir = path.join(getBrowserRuntimeDir(), 'sessions', task.name);
    const automaticPath = path.join(sessionsDir, `${Date.now()}.pdf`);
    const finalPath = resolveScreenshotOutputPath(outputPath, automaticPath);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(finalPath, buffer);

    return { path: finalPath, bytes: buffer.length };
  }

  // ─── Recording ──────────────────────────────────────────────────────────────
  //
  // CDP `Page.startScreencast` emits a JPEG frame per `everyNthFrame`. We pipe
  // those frames into ffmpeg's stdin (image2pipe) and encode to a webm/vp9 file
  // under `sessions/<task>/recordings/`. A background watcher enforces the
  // duration + size caps so a forgotten recording can't fill the disk.
  private recordings = new Map<string, {
    outputPath: string;
    startedAt: number;
    fps: number;
    maxBytes: number;
    durationMs: number;
    ffmpeg: import('child_process').ChildProcess;
    ffmpegStderr: () => string;
    sessionId: string;
    conn: ProfileConnection;
    frameHandler: (params: unknown) => void;
    durationTimer: NodeJS.Timeout;
    sizeCheckInterval: NodeJS.Timeout;
    stopReason?: 'manual' | 'duration-cap' | 'size-cap';
  }>();

  async recordStart(
    taskId: string,
    tabHint?: string,
    opts: { fps?: number; duration?: number; maxMb?: number } = {}
  ): Promise<{ path: string; fps: number; durationCapSec: number; maxMb: number }> {
    if (this.recordings.has(taskId)) {
      throw new Error(`Task "${taskId}" is already recording. Call record stop first.`);
    }

    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);
    const sessionId = await this.getSessionId(conn, target.targetId);

    const fps = opts.fps ?? 5;
    const durationSec = opts.duration ?? 60;
    const maxMb = opts.maxMb ?? 25;
    if (fps < 1 || fps > 30) throw new Error('--fps must be between 1 and 30');
    if (durationSec < 1 || durationSec > 3600) throw new Error('--duration must be between 1 and 3600 seconds');
    if (maxMb < 1 || maxMb > 500) throw new Error('--max-mb must be between 1 and 500');

    const recordingsDir = path.join(getBrowserRuntimeDir(), 'sessions', task.name, 'recordings');
    await fs.promises.mkdir(recordingsDir, { recursive: true });
    const outputPath = path.join(recordingsDir, `${Date.now()}.webm`);

    // Resolve ffmpeg lazily so non-recording paths don't pay the import cost.
    const { spawn } = await import('child_process');
    // CDP `Page.startScreencast` delivers frames at a VARIABLE cadence (paints
    // are event-driven, not clocked). Feeding those into a fixed `-framerate`
    // input made ffmpeg assume every frame was 1/fps apart, so a page that
    // painted slower/faster than `fps` played back at the wrong speed. Instead
    // stamp each frame with its wall-clock arrival time
    // (`-use_wallclock_as_timestamps 1`) and keep those timings on output
    // (`-vsync vfr`), so playback duration matches the real capture.
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-loglevel', 'error',
        '-f', 'image2pipe',
        '-use_wallclock_as_timestamps', '1',
        '-i', '-',
        '-c:v', 'libvpx-vp9',
        '-b:v', '1M',
        '-pix_fmt', 'yuv420p',
        '-vsync', 'vfr',
        '-y',
        outputPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );
    // Wait for the spawn to confirm (or fail) before we wire CDP frames into a
    // dead pipe. ENOENT from a missing ffmpeg surfaces here as a real error
    // instead of a silently empty .webm.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        ffmpeg.off('spawn', onSpawn);
        if (err.code === 'ENOENT') {
          reject(new Error('ffmpeg not found on PATH — install via `brew install ffmpeg`'));
        } else {
          reject(err);
        }
      };
      const onSpawn = () => {
        ffmpeg.off('error', onError);
        resolve();
      };
      ffmpeg.once('error', onError);
      ffmpeg.once('spawn', onSpawn);
    });

    // Capture ffmpeg's own diagnostics (encoder error, bad codec, etc.) so a
    // failing encode is DIAGNOSABLE at recordStop instead of being discarded.
    // Cap the buffer so a chatty ffmpeg can't grow it unbounded.
    let stderrBuf = '';
    ffmpeg.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
    });
    const ffmpegStderr = () => stderrBuf;
    ffmpeg.on('error', () => { /* post-spawn errors get reported via exit code */ });

    // 30 fps is CDP's screencast cap; everyNthFrame = round(30/fps).
    const everyNthFrame = Math.max(1, Math.round(30 / fps));
    await conn.cdp.send(
      'Page.startScreencast',
      { format: 'jpeg', quality: 60, everyNthFrame },
      sessionId
    );

    const frameHandler = (params: unknown) => {
      const p = params as { data: string; sessionId: number };
      try {
        ffmpeg.stdin?.write(Buffer.from(p.data, 'base64'));
      } catch {
        // ffmpeg exited; ignore writes
      }
      // Must ack every frame or CDP stops sending.
      conn.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch(() => {});
    };
    conn.cdp.on('Page.screencastFrame', frameHandler);

    const durationMs = durationSec * 1000;
    const maxBytes = maxMb * 1024 * 1024;

    const state = {
      outputPath,
      startedAt: Date.now(),
      fps,
      durationMs,
      maxBytes,
      ffmpeg,
      ffmpegStderr,
      sessionId,
      conn,
      frameHandler,
      durationTimer: setTimeout(() => {
        this.recordStop(taskId, 'duration-cap').catch(() => {});
      }, durationMs),
      sizeCheckInterval: setInterval(async () => {
        try {
          const st = await fs.promises.stat(outputPath);
          if (st.size >= maxBytes) {
            await this.recordStop(taskId, 'size-cap');
          }
        } catch {
          // File may not exist yet
        }
      }, 1000),
    };
    this.recordings.set(taskId, state);

    return { path: outputPath, fps, durationCapSec: durationSec, maxMb };
  }

  async recordStop(
    taskId: string,
    reason: 'manual' | 'duration-cap' | 'size-cap' = 'manual'
  ): Promise<{ path: string; bytes: number; durationMs: number; reason: string }> {
    const rec = this.recordings.get(taskId);
    if (!rec) {
      throw new Error(`Task "${taskId}" is not currently recording`);
    }
    if (rec.stopReason) {
      // Already stopping (e.g. size-cap fired while user also called stop).
      // Wait for in-flight finalize.
      while (this.recordings.has(taskId)) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    rec.stopReason = reason;

    clearTimeout(rec.durationTimer);
    clearInterval(rec.sizeCheckInterval);
    rec.conn.cdp.off('Page.screencastFrame', rec.frameHandler);

    try {
      await rec.conn.cdp.send('Page.stopScreencast', {}, rec.sessionId);
    } catch {
      // session may already be gone
    }

    // Close ffmpeg stdin so it flushes the output file cleanly, and observe how
    // it exits. A non-zero exit means the encode failed — the recording must
    // NOT be reported as success. If ffmpeg hangs, KILL it (don't just abandon
    // the promise, which leaked the process) and treat the recording as failed.
    const finalize = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      let done = false;
      const settle = (r: { code: number | null; timedOut: boolean }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try { rec.ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
        settle({ code: null, timedOut: true });
      }, 5000);
      rec.ffmpeg.once('exit', (code) => settle({ code, timedOut: false }));
      try {
        rec.ffmpeg.stdin?.end();
      } catch {
        // stdin already closed; wait for exit or the hard timeout above.
      }
    });

    const durationMs = Date.now() - rec.startedAt;
    // Drop the recording from the map before any throw, so a failed stop
    // doesn't wedge the task in a permanent "already recording" state.
    this.recordings.delete(taskId);

    if (finalize.timedOut) {
      throw new Error(
        `ffmpeg did not exit within 5s while finalizing the recording; killed it. ` +
          `The recording at ${rec.outputPath} is incomplete.`
      );
    }
    if (finalize.code !== 0) {
      const err = rec.ffmpegStderr().trim();
      throw new Error(
        `ffmpeg exited abnormally (code ${finalize.code}) while finalizing the recording at ` +
          `${rec.outputPath}; the file is likely corrupt or empty.` +
          (err ? ` ffmpeg: ${err.slice(-800)}` : '')
      );
    }

    let bytes = 0;
    try {
      const st = await fs.promises.stat(rec.outputPath);
      bytes = st.size;
    } catch {
      // ffmpeg exited 0 but the file is missing — still a failed recording.
    }
    return { path: rec.outputPath, bytes, durationMs, reason };
  }

  async recordStatus(taskId: string): Promise<{ recording: boolean; path?: string; elapsedMs?: number }> {
    const rec = this.recordings.get(taskId);
    if (!rec) return { recording: false };
    return { recording: true, path: rec.outputPath, elapsedMs: Date.now() - rec.startedAt };
  }

  async refs(
    taskId: string,
    tabHint?: string,
    opts: RefOpts = {}
  ): Promise<{ refs: string; nodeMap: Map<number, RefNode> }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const result = await getRefs(conn.cdp, sessionId, opts);
    // Snapshot the stable descriptors AND the opts they were numbered against
    // so a later click/type can self-heal a drifted ref by rebuilding with the
    // same filter. `refs()` is the sole owner of this cache — actions read it,
    // never overwrite it. Persist to tasks.json so it survives a daemon
    // restart.
    this.cacheRefDescriptors(task, shortId, result.nodeMap, result.opts);
    await this.saveTaskState(task.profile, conn.tasks);
    return { refs: result.refs, nodeMap: result.nodeMap };
  }

  /** Record the last ref listing (descriptors + opts) for a tab into state. */
  private cacheRefDescriptors(
    task: Task,
    shortId: string,
    nodeMap: Map<number, RefNode>,
    opts: { interactive: boolean; limit: number }
  ): void {
    if (!task.refDescriptors) task.refDescriptors = {};
    task.refDescriptors[shortId] = { descriptors: describeRefs(nodeMap), opts };
  }

  /**
   * Re-resolve a caller-supplied ref against a freshly-built node map, healing
   * it back to the right element when the integer ref has drifted since the
   * cached `refs` listing. Shared by `click` and `type` so both self-heal
   * identically. Returns the ref to act on plus, when a heal occurred, the
   * {@link HealInfo} to surface. Throws when the cached element is gone.
   */
  private resolveHealedRef(
    snapshot: RefSnapshot | undefined,
    nodeMap: Map<number, RefNode>,
    ref: number
  ): { targetRef: number; healed?: HealInfo } {
    const cached = snapshot?.descriptors.find((d) => d.ref === ref);
    if (!cached) return { targetRef: ref };

    const fresh = nodeMap.get(ref);
    const stillMatches =
      fresh !== undefined &&
      fresh.role === cached.role &&
      fresh.name === cached.name &&
      fresh.backendNodeId !== undefined;
    if (stillMatches) return { targetRef: ref };

    const newRef = healRef(cached, nodeMap);
    if (newRef === null) {
      throw new Error(
        `Ref ${ref} (${cached.role} "${cached.name}") could not be re-resolved: ` +
          `no matching element on the current page. Re-run 'browser refs' to ` +
          `refresh the ref numbers, or act by position with 'browser click --at X,Y'.`
      );
    }
    if (newRef === ref) return { targetRef: ref };

    console.error(
      `[browser] self-healed ref ${ref} -> ${newRef} (${cached.role} "${cached.name}") — ` +
        `cached descriptor re-matched after the ref drifted`
    );
    return { targetRef: newRef, healed: { from: ref, to: newRef, role: cached.role, name: cached.name } };
  }

  async click(taskId: string, ref: number, tabHint?: string): Promise<{ healed?: HealInfo }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    // Rebuild the node map with the SAME opts the cached listing was numbered
    // against, so the caller's ref lands on the element they saw in `browser
    // refs`. Rebuilding with a different filter (the old interactive:false)
    // renumbers every ref and defeats self-heal on the second click. Default
    // to the user-facing interactive numbering when no listing was cached yet.
    const snapshot = task.refDescriptors?.[shortId];
    const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
    const { nodeMap } = await getRefs(conn.cdp, sessionId, buildOpts);

    // Self-heal: the integer ref is positional and drifts on re-render. If the
    // fresh node at this position no longer matches the cached descriptor,
    // re-resolve (by attrs/proximity-tie-broken role+name) BEFORE clicking the
    // wrong element. The cache is owned by refs() and NOT rewritten here — the
    // caller's ref numbers stay anchored to the listing they came from.
    const { targetRef, healed } = this.resolveHealedRef(snapshot, nodeMap, ref);

    const { x, y } = await resolveRefToCoords(conn.cdp, sessionId, nodeMap, targetRef);
    await clickAtCoords(conn.cdp, sessionId, x, y);

    return healed ? { healed } : {};
  }

  /**
   * Click raw viewport coordinates, bypassing ref resolution entirely. Backs
   * `browser click --at X,Y` — the escape hatch when the accessibility tree
   * exposes no usable ref (canvas apps, custom-drawn UI) and the caller has
   * located the target from a screenshot.
   */
  async clickAt(taskId: string, x: number, y: number, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await clickAtCoords(conn.cdp, sessionId, x, y);
  }

  async type(taskId: string, ref: number, text: string, tabHint?: string, clear?: boolean): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    // Same self-healing story as click(): rebuild against the cached listing's
    // opts so refs line up with what the user saw, then heal a drifted ref
    // before typing into the wrong field.
    const snapshot = task.refDescriptors?.[shortId];
    const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
    const { nodeMap } = await getRefs(conn.cdp, sessionId, buildOpts);
    const { targetRef } = this.resolveHealedRef(snapshot, nodeMap, ref);
    const node = nodeMap.get(targetRef);
    if (!node) throw new Error(`Ref ${ref} not found`);
    if (node.editor) {
      await typeEditorText(conn.cdp, sessionId, node, text, clear);
    } else {
      if (node.backendNodeId) {
        await focusNode(conn.cdp, sessionId, node.backendNodeId);
      }
      await typeText(conn.cdp, sessionId, text);
    }
  }

  async press(taskId: string, key: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await pressKey(conn.cdp, sessionId, key);
  }

  async hover(taskId: string, ref: number, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: false, limit: 1000 });
    const { x, y } = await resolveRefToCoords(conn.cdp, sessionId, nodeMap, ref);
    await hoverAtCoords(conn.cdp, sessionId, x, y);
  }

  async scroll(
    taskId: string,
    deltaX: number,
    deltaY: number,
    atX?: number,
    atY?: number,
    tabHint?: string
  ): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await scrollAtCoords(conn.cdp, sessionId, atX ?? 0, atY ?? 0, deltaX, deltaY);
  }

  async upload(
    taskId: string,
    files: string[],
    options: {
      ref?: number;
      trigger?: number;
      mode?: UploadMode;
      tabHint?: string;
      timeout?: number;
    }
  ): Promise<{ mode: 'input' | 'drop' | 'chooser' }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = options.tabHint
      ? await this.resolveTabHint(conn, task, options.tabHint)
      : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    // Match the user-facing ref numbering from `agents browser refs` (which
    // defaults to interactive=true). The other action helpers in this file
    // use interactive=false historically, but that produces ref numbers the
    // user never sees — `--ref 1` then resolves to the RootWebArea instead of
    // the first interactive element. Match the listing the user actually saw.
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: true, limit: 1000 });

    const mode = options.mode ?? 'auto';

    if (options.trigger !== undefined || mode === 'chooser') {
      const ref = options.trigger ?? options.ref;
      if (ref === undefined) {
        throw new Error('chooser mode requires --trigger <ref> (or --ref) pointing at the button that opens the file dialog');
      }
      const node = nodeMap.get(ref);
      if (!node) throw new Error(`Ref ${ref} not found`);
      await uploadViaFileChooser(
        conn.cdp,
        sessionId,
        { node, nodeMap },
        files,
        options.timeout
      );
      return { mode: 'chooser' };
    }

    if (options.ref === undefined) {
      throw new Error('upload requires --ref <n> (target element) or --trigger <n> (button that opens chooser)');
    }
    const node = nodeMap.get(options.ref);
    if (!node) throw new Error(`Ref ${options.ref} not found`);
    if (!node.backendNodeId) throw new Error(`Ref ${options.ref} has no DOM node`);

    let resolved: 'input' | 'drop';
    if (mode === 'input') {
      resolved = 'input';
    } else if (mode === 'drop') {
      resolved = 'drop';
    } else {
      resolved = await detectUploadPattern(conn.cdp, sessionId, node.backendNodeId);
    }

    if (resolved === 'input') {
      await uploadToFileInput(conn.cdp, sessionId, node.backendNodeId, files);
    } else {
      await uploadToDropTarget(conn.cdp, sessionId, node.backendNodeId, files);
    }
    return { mode: resolved };
  }

  stageUpload(source: string): { path: string } {
    return { path: stageUploadFile(source) };
  }

  async status(profileName?: string): Promise<ProfileStatus[]> {
    const seen = new Set<string>();
    const statuses: ProfileStatus[] = [];

    const candidates = profileName ? [profileName] : Array.from(this.connections.keys());
    for (const name of candidates) {
      const status = await this.getProfileStatus(name);
      if (status) {
        statuses.push(status);
        seen.add(name);
      }
    }

    if (!profileName) {
      const profiles = await listProfiles();
      for (const profile of profiles) {
        if (seen.has(profile.name)) continue;
        const reconciled = await this.reconcileFromDisk(profile.name);
        if (reconciled) statuses.push(reconciled);
      }
    } else if (!seen.has(profileName)) {
      const reconciled = await this.reconcileFromDisk(profileName);
      if (reconciled) statuses.push(reconciled);
    }

    return statuses;
  }

  private async reconcileFromDisk(profileName: string): Promise<ProfileStatus | null> {
    const info = getRunningChromeInfo(profileName);
    if (!info) return null;

    const profile = await getProfile(profileName);
    const tasks = this.loadTaskState(profileName);
    const taskStatuses: TaskStatus[] = [];
    for (const [, task] of tasks) {
      taskStatuses.push({
        id: task.id,
        name: task.name,
        tabCount: Object.keys(task.tabs).length,
        currentTabId: task.currentTabId,
        createdAt: task.createdAt,
      });
    }

    const configuredPort = profile ? extractConfiguredPort(profile) : undefined;

    return {
      name: profileName,
      running: true,
      port: info.port,
      pid: info.pid,
      configuredPort: configuredPort !== info.port ? configuredPort : undefined,
      tasks: taskStatuses,
    };
  }

  // ─── Viewport & Device Emulation ──────────────────────────────────────────────

  async setViewport(
    taskId: string,
    width: number,
    height: number,
    options: { mobile?: boolean; deviceScaleFactor?: number; tabHint?: string } = {}
  ): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);

    await conn.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width,
        height,
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
        mobile: options.mobile ?? false,
      },
      sessionId
    );
  }

  async setDevice(taskId: string, deviceName: string, tabHint?: string): Promise<void> {
    const { getDevice } = await import('./devices.js');
    const device = getDevice(deviceName);
    if (!device) {
      const { listDevices } = await import('./devices.js');
      throw new Error(`Unknown device "${deviceName}". Available: ${listDevices().join(', ')}`);
    }
    await this.setViewport(taskId, device.width, device.height, {
      mobile: device.mobile,
      deviceScaleFactor: device.deviceScaleFactor,
      tabHint,
    });
  }

  // ─── Console & Errors ────────────────────────────────────────────────────────

  private async enableRuntimeForSession(conn: ProfileConnection, sessionId: string): Promise<void> {
    const key = `${sessionId}:Runtime`;
    if (this.enabledSessions.get(sessionId)?.has('Runtime')) return;

    await conn.cdp.send('Runtime.enable', {}, sessionId);

    if (!this.enabledSessions.has(sessionId)) {
      this.enabledSessions.set(sessionId, new Set());
    }
    this.enabledSessions.get(sessionId)!.add('Runtime');

    conn.cdp.on('Runtime.consoleAPICalled', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const taskId = this.findTaskBySession(conn, sessionId);
      if (!taskId) return;

      const entry: import('./types.js').ConsoleEntry = {
        level: params.type === 'warning' ? 'warn' : params.type,
        text: params.args?.map((a: any) => a.value ?? a.description ?? '').join(' ') || '',
        timestamp: Date.now(),
        url: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      };

      if (!this.consoleLogs.has(taskId)) this.consoleLogs.set(taskId, []);
      const logs = this.consoleLogs.get(taskId)!;
      logs.push(entry);
      if (logs.length > 1000) logs.shift();
    });

    conn.cdp.on('Runtime.exceptionThrown', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const taskId = this.findTaskBySession(conn, sessionId);
      if (!taskId) return;

      const ex = params.exceptionDetails;
      const entry: import('./types.js').ErrorEntry = {
        message: ex.exception?.description || ex.text || 'Unknown error',
        stack: ex.stackTrace?.callFrames?.map((f: any) => `  at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber})`).join('\n'),
        timestamp: Date.now(),
        url: ex.url,
        line: ex.lineNumber,
      };

      if (!this.pageErrors.has(taskId)) this.pageErrors.set(taskId, []);
      const errors = this.pageErrors.get(taskId)!;
      errors.push(entry);
      if (errors.length > 500) errors.shift();
    });
  }

  async getConsoleLogs(
    taskId: string,
    options: { level?: string; clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').ConsoleEntry[]> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableRuntimeForSession(conn, sessionId);

    let logs = this.consoleLogs.get(taskId) || [];
    if (options.level) {
      logs = logs.filter((l) => l.level === options.level);
    }
    if (options.clear) {
      this.consoleLogs.set(taskId, []);
    }
    return logs;
  }

  async getErrors(
    taskId: string,
    options: { clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').ErrorEntry[]> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableRuntimeForSession(conn, sessionId);

    const errors = this.pageErrors.get(taskId) || [];
    if (options.clear) {
      this.pageErrors.set(taskId, []);
    }
    return errors;
  }

  // ─── Network Requests ────────────────────────────────────────────────────────

  private async enableNetworkForSession(conn: ProfileConnection, sessionId: string, taskId: string): Promise<void> {
    if (this.enabledSessions.get(sessionId)?.has('Network')) return;

    await conn.cdp.send('Network.enable', {}, sessionId);

    if (!this.enabledSessions.has(sessionId)) {
      this.enabledSessions.set(sessionId, new Set());
    }
    this.enabledSessions.get(sessionId)!.add('Network');

    const requestMap = new Map<string, import('./types.js').NetworkRequest>();

    conn.cdp.on('Network.requestWillBeSent', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const req: import('./types.js').NetworkRequest = {
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: Date.now(),
      };
      requestMap.set(params.requestId, req);

      if (!this.networkRequests.has(taskId)) this.networkRequests.set(taskId, []);
      const reqs = this.networkRequests.get(taskId)!;
      reqs.push(req);
      if (reqs.length > 500) reqs.shift();
    });

    conn.cdp.on('Network.responseReceived', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const req = requestMap.get(params.requestId);
      if (req) {
        req.status = params.response.status;
        req.mimeType = params.response.mimeType;
      }
    });
  }

  async getNetworkRequests(
    taskId: string,
    options: { filter?: string; clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').NetworkRequest[]> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableNetworkForSession(conn, sessionId, taskId);

    let requests = this.networkRequests.get(taskId) || [];
    if (options.filter) {
      const f = options.filter.toLowerCase();
      requests = requests.filter((r) => r.url.toLowerCase().includes(f));
    }
    if (options.clear) {
      this.networkRequests.set(taskId, []);
    }
    return requests;
  }

  async getResponseBody(
    taskId: string,
    urlPattern: string,
    options: { timeout?: number; maxChars?: number; tabHint?: string } = {}
  ): Promise<string> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableNetworkForSession(conn, sessionId, taskId);

    const timeout = options.timeout ?? 30000;
    const maxChars = options.maxChars ?? 200000;
    const start = Date.now();
    const pattern = urlPattern.includes('*')
      ? new RegExp(urlPattern.replace(/\*/g, '.*'), 'i')
      : null;

    while (Date.now() - start < timeout) {
      const requests = this.networkRequests.get(taskId) || [];
      const match = requests.find((r) =>
        pattern ? pattern.test(r.url) : r.url.includes(urlPattern)
      );

      if (match && match.status) {
        try {
          const { body, base64Encoded } = (await conn.cdp.send(
            'Network.getResponseBody',
            { requestId: match.id },
            sessionId
          )) as { body: string; base64Encoded: boolean };

          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
          return text.slice(0, maxChars);
        } catch {
          // Request may have been evicted, continue waiting
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(`No response matching "${urlPattern}" within ${timeout}ms`);
  }

  // ─── App Logs (source-side JSONL) ───────────────────────────────────────────

  async getAppLogs(
    taskId: string,
    opts: {
      lines?: number;
      level?: string;
      filter?: string;
      message?: string;
      source?: string;
      since?: string;
      until?: string;
    }
  ): Promise<any[]> {
    const { task } = await this.findTask(taskId);
    const baseProfileName = task.profile.split('@')[0];
    const profile = await getProfile(baseProfileName);
    if (!profile?.logDir) {
      throw new Error(`Profile '${task.profile}' has no logDir set`);
    }
    const logDir = expandHome(profile.logDir);

    const sources = opts.source ? [opts.source] : ['rush-app', 'rush-cli'];
    const since = opts.since ? parseSinceUntil(opts.since) : null;
    const until = opts.until ? parseSinceUntil(opts.until) : null;
    const tailN = since ? 100_000 : (opts.lines ?? 200);

    const raws = await Promise.all(
      sources.map(async (src) => {
        const prefix = BrowserService.SOURCE_PREFIX[src];
        if (!prefix) return '';
        if (profile.logHost) {
          return execSSH(
            profile.logHost,
            readNewestMatchingRemoteFileCommand(logDir, prefix, tailN)
          );
        }
        return readNewestMatchingFile(logDir, prefix, tailN);
      })
    );

    const entries = raws
      .flatMap((r) => r.split('\n').filter(Boolean))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .filter((e) => !opts.level || e.level === opts.level)
      .filter((e) => !opts.message || e.message === opts.message)
      .filter((e) => !opts.filter || JSON.stringify(e).includes(opts.filter))
      .filter((e) => !since || (e.timestamp && new Date(e.timestamp) >= since))
      .filter((e) => !until || (e.timestamp && new Date(e.timestamp) <= until))
      .sort(
        (a, b) =>
          new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime()
      );

    return since ? entries : entries.slice(-(opts.lines ?? 200));
  }

  // ─── Wait Conditions ─────────────────────────────────────────────────────────

  async wait(
    taskId: string,
    type: 'time' | 'selector' | 'url' | 'function' | 'load',
    value: string | number,
    options: { timeout?: number; tabHint?: string } = {}
  ): Promise<void> {
    const timeout = options.timeout ?? 30000;

    if (type === 'time') {
      await new Promise((r) => setTimeout(r, typeof value === 'number' ? value : parseInt(value as string, 10)));
      return;
    }

    const { conn, task } = await this.findTask(taskId);
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const start = Date.now();

    while (Date.now() - start < timeout) {
      let condition = false;

      if (type === 'selector') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: `!!document.querySelector(${JSON.stringify(value)})`, returnByValue: true },
          sessionId
        )) as { result: { value: boolean } };
        condition = result.result.value === true;
      } else if (type === 'url') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          sessionId
        )) as { result: { value: string } };
        const pattern = (value as string).includes('*')
          ? new RegExp((value as string).replace(/\*/g, '.*'), 'i')
          : null;
        condition = pattern ? pattern.test(result.result.value) : result.result.value.includes(value as string);
      } else if (type === 'function') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: `!!(${value})`, returnByValue: true },
          sessionId
        )) as { result: { value: boolean } };
        condition = result.result.value === true;
      } else if (type === 'load') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          sessionId
        )) as { result: { value: string } };
        if (value === 'domcontentloaded') {
          condition = result.result.value !== 'loading';
        } else if (value === 'load' || value === 'complete') {
          condition = result.result.value === 'complete';
        } else if (value === 'networkidle') {
          // Simplified: check if document is complete
          condition = result.result.value === 'complete';
        }
      }

      if (condition) return;
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error(`Wait condition "${type}:${value}" not met within ${timeout}ms`);
  }

  // ─── Downloads ───────────────────────────────────────────────────────────────

  async setDownloadPath(taskId: string, downloadPath: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);

    await conn.cdp.send(
      'Browser.setDownloadBehavior',
      {
        behavior: 'allow',
        downloadPath,
        eventsEnabled: true,
      },
      sessionId
    );

    this.pendingDownloads.set(taskId, { path: downloadPath, completed: false });

    conn.cdp.on('Browser.downloadProgress', (params: any) => {
      if (params.state === 'completed') {
        const dl = this.pendingDownloads.get(taskId);
        if (dl) {
          dl.completed = true;
          dl.filename = params.suggestedFilename;
        }
      }
    });
  }

  async waitForDownload(taskId: string, timeout: number = 60000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const dl = this.pendingDownloads.get(taskId);
      if (dl?.completed) {
        const fullPath = dl.filename ? `${dl.path}/${dl.filename}` : dl.path;
        this.pendingDownloads.delete(taskId);
        return fullPath;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Download not completed within ${timeout}ms`);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private findTaskBySession(conn: ProfileConnection, sessionId: string): string | undefined {
    for (const [taskId, task] of conn.tasks) {
      for (const tabId of Object.values(task.tabs)) {
        if (conn.sessionCache.get(tabId) === sessionId) {
          return taskId;
        }
      }
    }
    return undefined;
  }

  async shutdown(): Promise<void> {
    // Drain any in-flight recordings first so we don't orphan ffmpeg processes
    // or leak the duration/size-check timers when the daemon goes down.
    for (const [taskId, rec] of this.recordings) {
      clearTimeout(rec.durationTimer);
      clearInterval(rec.sizeCheckInterval);
      try { rec.conn.cdp.off('Page.screencastFrame', rec.frameHandler); } catch { /* socket may be gone */ }
      try { rec.ffmpeg.stdin?.end(); } catch { /* already closed */ }
      // Give ffmpeg up to 1s to flush; then SIGKILL.
      const exited = await new Promise<boolean>((resolve) => {
        let done = false;
        rec.ffmpeg.once('exit', () => { done = true; resolve(true); });
        setTimeout(() => { if (!done) resolve(false); }, 1000);
      });
      if (!exited) {
        try { rec.ffmpeg.kill('SIGKILL'); } catch { /* already dead */ }
      }
      this.recordings.delete(taskId);
    }

    for (const [, conn] of this.connections) {
      conn.cdp.close();
      conn.cleanup?.();
    }
    this.connections.clear();
  }

  private findAvailableFork(
    profileName: string
  ): { name: string; conn: ProfileConnection } | null {
    for (const [name, conn] of this.connections) {
      if (conn.forkedFrom === profileName && conn.tasks.size === 0) {
        return { name, conn };
      }
    }
    return null;
  }

  private async forkElectronProfile(
    profile: BrowserProfile
  ): Promise<{ forkName: string; connection: ProfileConnection }> {
    let forkNum = 2;
    while (this.connections.has(`${profile.name}.${forkNum}`)) {
      forkNum++;
    }
    const forkName = `${profile.name}.${forkNum}`;

    const port = allocatePort();
    const chromeOpts = { ...profile.chrome, viewport: profile.viewport };
    const { pid, wsUrl } = await launchBrowser(
      forkName,
      profile.browser,
      port,
      chromeOpts,
      profile.secrets,
      profile.binary,
      profile.electron === true
    );

    const cdp = new CDPClient();
    await cdp.connect(wsUrl);
    await this.enableDomains(cdp);

    const connection: ProfileConnection = {
      cdp,
      port,
      pid,
      electron: true,
      targetFilter: profile.targetFilter,
      forkedFrom: profile.name,
      tasks: new Map(),
      sessionCache: new Map(),
    };
    this.connections.set(forkName, connection);

    return { forkName, connection };
  }

  /**
   * Connect to a profile at a specific endpoint preset. The caller has
   * already resolved the endpoint and built the `effectiveProfile` with
   * the per-endpoint binary/targetFilter overrides applied; we just use it.
   *
   * `effectiveProfile.name` is the composite identifier (`<profile>@<endpoint>`)
   * so per-endpoint pid/port files don't collide when the same app runs
   * locally and remotely at the same time.
   */
  private async connectProfile(
    effectiveProfile: BrowserProfile,
    target: string
  ): Promise<ProfileConnection> {
    const existingInfo = getRunningChromeInfo(effectiveProfile.name);

    if (existingInfo) {
      try {
        const { wsUrl, browser } = await discoverBrowserWsUrl(
          existingInfo.port,
          'localhost',
          effectiveProfile.name
        );
        verifyBrowserIdentity(browser, effectiveProfile.browser, existingInfo.port);
        const cdp = new CDPClient();
        await cdp.connect(wsUrl);
        await this.enableDomains(cdp);

        const tasks = this.loadTaskState(effectiveProfile.name);

        return {
          cdp,
          port: existingInfo.port,
          pid: existingInfo.pid,
          electron: effectiveProfile.electron,
          targetFilter: effectiveProfile.targetFilter,
          tasks,
          sessionCache: new Map(),
        };
      } catch (err) {
        // pid file says a process is alive on that port, but nothing is
        // actually responding to CDP — most commonly because the user
        // changed the configured endpoint port after a previous launch,
        // or because the OS reused the pid for an unrelated process.
        // Wipe the stale runtime files and fall through to a fresh
        // connect against the profile's currently-configured endpoint.
        clearProfileRuntime(effectiveProfile.name);
      }
    }

    const conn = await this.connectEndpoint(effectiveProfile, target);
    if (!conn) {
      throw new Error(`Could not connect to endpoint ${target} for profile "${effectiveProfile.name}"`);
    }
    return conn;
  }

  private async connectEndpoint(
    profile: BrowserProfile,
    endpoint: string
  ): Promise<ProfileConnection | null> {
    const url = new URL(endpoint);

    if (url.protocol === 'cdp:') {
      const conn = await connectLocal(endpoint, profile);
      await this.enableDomains(conn.cdp);
      return {
        cdp: conn.cdp,
        port: conn.port,
        pid: conn.pid,
        electron: profile.electron,
        targetFilter: profile.targetFilter,
        tasks: conn.pid === 0 ? this.loadTaskState(profile.name) : new Map(),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'ssh:') {
      const conn = await connectSSH(endpoint, profile);
      await this.enableDomains(conn.cdp);
      return {
        cdp: conn.cdp,
        port: conn.port,
        pid: conn.pid,
        electron: profile.electron,
        targetFilter: profile.targetFilter,
        tasks: new Map(),
        sessionCache: new Map(),
        cleanup: conn.cleanup,
      };
    }

    if (url.protocol === 'wss:' || url.protocol === 'ws:') {
      const port = parseInt(url.port || (url.protocol === 'wss:' ? '443' : '80'), 10);
      const cdp = new CDPClient();
      try {
        await cdp.connect(endpoint);
      } catch {
        throw new BrowserCdpConnectionError(port, profile.name, url.hostname || 'localhost');
      }
      await this.enableDomains(cdp);
      return {
        cdp,
        port: 0,
        pid: 0,
        electron: profile.electron,
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(profile.name),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
      const { wsUrl, browser } = await discoverBrowserWsUrl(port, url.hostname, profile.name);
      verifyBrowserIdentity(browser, profile.browser, port, url.hostname);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);
      return {
        cdp,
        port,
        pid: 0,
        electron: profile.electron,
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(profile.name),
        sessionCache: new Map(),
      };
    }

    return null;
  }

  private async enableDomains(cdp: CDPClient): Promise<void> {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }

  private async getOrCreateWindow(conn: ProfileConnection): Promise<string> {
    // Already have a window for this profile?
    if (conn.windowId) {
      // Verify it still exists via CDP
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }>;
      };
      if (targetInfos.some((t) => t.targetId === conn.windowId && t.type === 'page')) {
        return conn.windowId;
      }
      // Window was closed, fall through to find/create new
    }

    // Check if browser already has a page target we can use
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }>;
    };
    const existing = pickWindowTarget(targetInfos, conn.targetFilter);
    if (existing) {
      conn.windowId = existing.targetId;
      return existing.targetId;
    }

    // If we have an explicit filter, `pickWindowTarget` returns undefined when nothing
    // matches. That almost always means the profile is misconfigured (typo in the
    // filter, target hasn't loaded yet, app version moved the URL). Falling through
    // to `Target.createTarget` would silently create an orphan tab the user can't see.
    // Surface the failure instead, with the candidate list so the fix is obvious.
    if (parseTargetFilter(conn.targetFilter)) {
      const candidates = targetInfos
        .filter((t) => t.type === 'page')
        .map((t) => `  - url=${t.url ?? ''} title=${t.title ?? ''}`)
        .join('\n');
      throw new Error(
        `Target filter ${JSON.stringify(conn.targetFilter)} matched no page target.\n` +
          `Available page targets:\n${candidates || '  (none)'}`
      );
    }

    // First ever use - create window
    const result = (await conn.cdp.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    })) as { targetId: string };
    conn.windowId = result.targetId;
    return result.targetId;
  }

  private hasTaskNamed(name: string): boolean {
    for (const conn of this.connections.values()) {
      if (conn.tasks.has(name)) return true;
    }
    return false;
  }

  private generateUniqueTaskName(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateTaskName();
      if (!this.hasTaskNamed(candidate)) return candidate;
    }
    throw new Error('Could not generate unique task name after 8 attempts');
  }

  private async findTask(
    taskId: string,
    profileName?: string
  ): Promise<{ conn: ProfileConnection; task: Task }> {
    if (profileName) {
      const conn = this.connections.get(profileName);
      if (!conn) {
        throw new Error(`Profile "${profileName}" not connected`);
      }
      const task = conn.tasks.get(taskId);
      if (!task) {
        throw new Error(`Task "${taskId}" not found on profile "${profileName}"`);
      }
      return { conn, task };
    }

    for (const [, conn] of this.connections) {
      const task = conn.tasks.get(taskId);
      if (task) {
        return { conn, task };
      }
    }

    throw new Error(`Task "${taskId}" not found`);
  }

  private async getTabsForTask(cdp: CDPClient, task: Task): Promise<TabInfo[]> {
    const targets = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string; title: string }>;
    };

    const tabs: TabInfo[] = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target) {
        tabs.push({
          id: shortId,
          url: target.url,
          title: target.title,
          task: task.name,
        });
      }
    }
    return tabs;
  }

  private async getProfileStatus(profileName: string): Promise<ProfileStatus | null> {
    const conn = this.connections.get(profileName);
    if (!conn) return null;

    // Fetch all targets once for efficiency
    let targets: Array<{ targetId: string; url: string; title: string }> = [];
    try {
      const result = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; url: string; title: string }>;
      };
      targets = result.targetInfos;
    } catch {
      // CDP not responding, fall back to metadata only
    }

    const tasks: TaskStatus[] = [];
    for (const [, task] of conn.tasks) {
      const tabs: Array<{ id: string; url: string; title?: string; current?: boolean }> = [];
      const domainSet = new Set<string>();

      for (const [shortId, cdpId] of Object.entries(task.tabs)) {
        const target = targets.find((t) => t.targetId === cdpId);
        if (target) {
          tabs.push({
            id: shortId,
            url: target.url,
            title: target.title,
            current: shortId === task.currentTabId,
          });
          try {
            const domain = new URL(target.url).hostname.replace(/^www\./, '');
            if (domain && domain !== 'blank') domainSet.add(domain);
          } catch {
            // invalid URL
          }
        }
      }

      tasks.push({
        id: task.id,
        name: task.name,
        tabCount: Object.keys(task.tabs).length,
        currentTabId: task.currentTabId,
        createdAt: task.createdAt,
        tabs: tabs.length > 0 ? tabs : undefined,
        domains: domainSet.size > 0 ? Array.from(domainSet) : undefined,
      });
    }

    const profile = await getProfile(profileName);
    const configuredPort = profile ? extractConfiguredPort(profile) : undefined;

    return {
      name: profileName,
      running: true,
      port: conn.port,
      pid: conn.pid,
      configuredPort: configuredPort !== conn.port ? configuredPort : undefined,
      tasks,
    };
  }

  private async getTarget(
    conn: ProfileConnection,
    tabId: string
  ): Promise<TargetInfo | undefined> {
    const now = Date.now();
    if (!conn.targetCache || now - conn.targetCache.ts > 1000) {
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: TargetInfo[];
      };
      conn.targetCache = { targets: targetInfos, ts: now };
    }

    return conn.targetCache.targets.find((target) => target.targetId === tabId);
  }

  private async getSessionId(conn: ProfileConnection, tabId: string): Promise<string> {
    const cachedSessionId = conn.sessionCache.get(tabId);
    if (cachedSessionId) {
      return cachedSessionId;
    }

    const { sessionId } = (await conn.cdp.send('Target.attachToTarget', {
      targetId: tabId,
      flatten: true,
    })) as { sessionId: string };

    // Inject a stealth shim before any page script runs. Chromium exposes
    // navigator.webdriver = true whenever a remote-debug transport is attached;
    // Cloudflare Turnstile, hCaptcha, and similar bot checks read it first.
    //
    // Only attach-to-running profiles (conn.pid === 0 — Comet / Arc / Brave the
    // user launched themselves) need this. Browsers agents-cli spawns already
    // carry the --disable-blink-features=AutomationControlled launch flag, which
    // makes navigator.webdriver a native Navigator.prototype getter returning
    // false — indistinguishable from an untouched browser. Injecting on top of
    // that is actively harmful: it defines an OWN getter on the instance, and an
    // own `webdriver` descriptor (native lives on the prototype) returning
    // `undefined` (native returns `false`) is itself a tampering signal that
    // bot.sannysoft.com and similar tests flag as "WebDriver present".
    //
    // When we do inject (attach mode), mirror native semantics exactly: define
    // on Navigator.prototype and return false, so no own descriptor leaks and
    // the value matches a real browser. Non-page targets (workers, service
    // workers) reject these calls; swallow the error and keep going.
    if (conn.pid === 0) {
      try {
        await conn.cdp.send('Page.enable', {}, sessionId);
        await conn.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source:
            "Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>false,configurable:true});",
        }, sessionId);
      } catch {
        // Target doesn't support Page domain — nothing to inject.
      }
    }

    conn.sessionCache.set(tabId, sessionId);
    return sessionId;
  }

  private invalidateTargetCache(conn: ProfileConnection): void {
    conn.targetCache = undefined;
  }

  private async saveTaskState(profileName: string, tasks: Map<string, Task>): Promise<void> {
    const runtimeDir = getProfileRuntimeDir(profileName);
    await fs.promises.mkdir(runtimeDir, { recursive: true });

    const state = Object.fromEntries(tasks);
    await fs.promises.writeFile(
      path.join(runtimeDir, 'tasks.json'),
      JSON.stringify(state, null, 2)
    );
  }

  private loadTaskState(profileName: string): Map<string, Task> {
    const runtimeDir = getProfileRuntimeDir(profileName);
    const tasksFile = path.join(runtimeDir, 'tasks.json');

    if (!fs.existsSync(tasksFile)) {
      return new Map();
    }

    const state = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    const tasks = new Map<string, Task>();
    let needsMigration = false;

    for (const [key, raw] of Object.entries(state)) {
      const task = raw as Record<string, unknown>;
      // Migrate old format (tabIds array) to new format (tabs object)
      if (Array.isArray(task.tabIds) && !task.tabs) {
        needsMigration = true;
        const tabs: Record<string, string> = {};
        for (const cdpId of task.tabIds as string[]) {
          const shortId = generateShortId();
          tabs[shortId] = cdpId;
        }
        const tabIds = Object.keys(tabs);
        tasks.set(key, {
          id: task.id as string,
          name: task.name as string || key,
          profile: task.profile as string,
          tabs,
          currentTabId: tabIds.length > 0 ? tabIds[tabIds.length - 1] : undefined,
          createdAt: task.createdAt as number,
          pid: task.pid as number,
        });
      } else {
        tasks.set(key, task as unknown as Task);
      }
    }

    // Save migrated data back to disk
    if (needsMigration) {
      const migratedState = Object.fromEntries(tasks);
      fs.writeFileSync(tasksFile, JSON.stringify(migratedState, null, 2));
    }

    return tasks;
  }

  private async saveToHistory(task: Task, domains: string[]): Promise<void> {
    const historyDir = getBrowserRuntimeDir();
    await fs.promises.mkdir(historyDir, { recursive: true });
    const historyFile = path.join(historyDir, 'history.json');

    let history: HistoricalTask[] = [];
    if (fs.existsSync(historyFile)) {
      try {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      } catch {
        // Corrupted file, start fresh
      }
    }

    history.unshift({
      id: task.id,
      name: task.name,
      profile: task.profile,
      createdAt: task.createdAt,
      endedAt: Date.now(),
      domains,
      tabCount: Object.keys(task.tabs).length,
    });

    // Keep only last 50 entries
    history = history.slice(0, 50);
    await fs.promises.writeFile(historyFile, JSON.stringify(history, null, 2));
  }

  async getHistory(limit = 10): Promise<HistoricalTask[]> {
    const historyFile = path.join(getBrowserRuntimeDir(), 'history.json');
    if (!fs.existsSync(historyFile)) return [];

    try {
      const history: HistoricalTask[] = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      return history.slice(0, limit);
    } catch {
      return [];
    }
  }
}
