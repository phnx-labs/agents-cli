import * as fs from 'fs';
import * as path from 'path';
import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from './cdp.js';
import {
  getProfile,
  getProfileRuntimeDir,
  getBrowserRuntimeDir,
  listProfiles,
  extractConfiguredPort,
} from './profiles.js';
import { killChrome, getRunningChromeInfo, launchBrowser, allocatePort } from './chrome.js';
import { connectLocal } from './drivers/local.js';
import { connectSSH } from './drivers/ssh.js';
import {
  generateTaskId,
  generateShortId,
  generateFunName,
  isValidTaskId,
  type Task,
  type TabInfo,
  type ProfileStatus,
  type TaskStatus,
  type BrowserProfile,
  type HistoricalTask,
} from './types.js';
import { getRefs, resolveRefToCoords, type RefOpts, type RefNode } from './refs.js';
import { clickAtCoords, hoverAtCoords, scrollAtCoords, typeText, pressKey, focusNode } from './input.js';
import { typeEditorText } from './editor.js';
import {
  detectUploadPattern,
  uploadToDropTarget,
  uploadToFileInput,
  uploadViaFileChooser,
} from './upload.js';
import { emit } from '../events.js';
import type { TargetFilter } from './types.js';

export type UploadMode = 'auto' | 'input' | 'drop' | 'chooser';

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
}

type TargetInfo = {
  targetId: string;
  url?: string;
  title?: string;
};

export class BrowserService {
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
    opts: { taskName?: string; url?: string } = {}
  ): Promise<{ task: string; name: string; tabId?: string; windowId?: string }> {
    const profile = await getProfile(profileName);
    if (!profile) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    const taskName = opts.taskName || generateFunName();
    const taskId = generateTaskId();

    let conn = this.connections.get(profileName);
    let effectiveProfileName = profileName;

    if (conn && conn.electron && conn.tasks.size > 0) {
      if (this.forkingProfiles.has(profileName)) {
        while (this.forkingProfiles.has(profileName)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const existingFork = this.findAvailableFork(profileName);
        if (existingFork) {
          conn = existingFork.conn;
          effectiveProfileName = existingFork.name;
        } else {
          throw new Error(`Fork in progress but no available fork found for "${profileName}"`);
        }
      } else {
        this.forkingProfiles.add(profileName);
        try {
          const { forkName, connection } = await this.forkElectronProfile(profile);
          conn = connection;
          effectiveProfileName = forkName;
        } finally {
          this.forkingProfiles.delete(profileName);
        }
      }
    } else if (!conn) {
      conn = await this.connectProfile(profile);
      this.connections.set(profileName, conn);
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

    return { task: taskId, name: taskName, tabId };
  }

  /**
   * Launch (or attach to) the profile's browser without creating a task. Used by
   * `agents browser profiles launch <name>` so users can warm up the browser —
   * including the first-run onboarding flow — before any automation starts.
   */
  async launchProfile(profileName: string): Promise<{ port: number; pid: number }> {
    const profile = await getProfile(profileName);
    if (!profile) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    let conn = this.connections.get(profileName);
    if (!conn) {
      conn = await this.connectProfile(profile);
      this.connections.set(profileName, conn);
    }

    emit('browser.launch', { profile: profileName, task: '', pid: conn.pid });
    return { port: conn.port, pid: conn.pid };
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
    const conn = this.connections.get(profileName);
    if (conn) {
      conn.cdp.close();
      killChrome(conn.pid);
      this.connections.delete(profileName);
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
    outputPath?: string
  ): Promise<string> {
    const { conn, task } = await this.findTask(taskId);

    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    const { data } = (await conn.cdp.send(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 70 },
      sessionId
    )) as { data: string };

    let buffer = Buffer.from(data, 'base64');

    const MAX_SIZE = 100 * 1024;
    if (buffer.length > MAX_SIZE) {
      let quality = 50;
      while (buffer.length > MAX_SIZE && quality > 10) {
        const { data: resized } = (await conn.cdp.send(
          'Page.captureScreenshot',
          { format: 'jpeg', quality },
          sessionId
        )) as { data: string };
        buffer = Buffer.from(resized, 'base64');
        quality -= 10;
      }
    }

    const sessionsDir = path.join(getBrowserRuntimeDir(), 'sessions', task.name);
    const finalPath = outputPath || path.join(sessionsDir, `${Date.now()}.jpg`);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(finalPath, buffer);

    return finalPath;
  }

  private refsCache = new Map<string, { refs: string; nodeMap: Map<number, RefNode>; ts: number }>();

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
    return getRefs(conn.cdp, sessionId, opts);
  }

  async click(taskId: string, ref: number, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: false, limit: 1000 });
    const { x, y } = await resolveRefToCoords(conn.cdp, sessionId, nodeMap, ref);
    await clickAtCoords(conn.cdp, sessionId, x, y);
  }

  async type(taskId: string, ref: number, text: string, tabHint?: string, clear?: boolean): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: false, limit: 1000 });
    const node = nodeMap.get(ref);
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
    for (const [, conn] of this.connections) {
      conn.cdp.close();
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
      profile.binary
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

  private async connectProfile(profile: BrowserProfile): Promise<ProfileConnection> {
    const existingInfo = getRunningChromeInfo(profile.name);

    if (existingInfo) {
      const { wsUrl, browser } = await discoverBrowserWsUrl(existingInfo.port);
      verifyBrowserIdentity(browser, profile.browser, existingInfo.port);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);

      const tasks = this.loadTaskState(profile.name);

      return {
        cdp,
        port: existingInfo.port,
        pid: existingInfo.pid,
        electron: profile.electron,
        targetFilter: profile.targetFilter,
        tasks,
        sessionCache: new Map(),
      };
    }

    for (const endpoint of profile.endpoints) {
      try {
        const conn = await this.connectEndpoint(profile, endpoint);
        if (conn) return conn;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Browser identity mismatch')) {
          throw err;
        }
        // Try next endpoint
      }
    }

    throw new Error(`Could not connect to any endpoint for profile "${profile.name}"`);
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
      };
    }

    if (url.protocol === 'wss:' || url.protocol === 'ws:') {
      const cdp = new CDPClient();
      await cdp.connect(endpoint);
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
      const { wsUrl, browser } = await discoverBrowserWsUrl(port, url.hostname);
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
