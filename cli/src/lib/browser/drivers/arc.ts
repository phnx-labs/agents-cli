/**
 * Native Arc browser driver via AppleScript/Apple Events (PHNX-2399).
 *
 * Drives an already-running Arc browser through Apple Events (`osascript` via
 * stdin). Never launches, kills, or restarts Arc. Never uses CDP — this is the
 * native-only transport for profiles without a debugging port.
 *
 * ## Design constraints (from parent testing on Arc 1.162.0)
 *
 * - **Creation id dereference broken (-1700)**: Arc's `make new tab` returns a
 *   malformed object. Tab creation uses a unique URL marker then resolves by
 *   enumerating and matching.
 * - **Direct window/space references crash**: `first window whose id is ...`
 *   materializes a broken specifier. Use explicit positional references:
 *   `a reference to space si of window wi` / `a reference to tab ti of targetSpace`.
 * - **Isolated world execution**: `execute javascript` runs in an isolated
 *   world — page globals are inaccessible even when inline scripts ran.
 * - **Return envelope**: `execute javascript` returns an object envelope directly;
 *   `JSON.parse(raw)` yields the object. Never double-JSON.stringify.
 * - **Events isTrusted=false**: Synthetic events from execute JS are not trusted.
 * - **visible:false ignored**: `make new window {visible:false}` still shows.
 * - **Background: NOT proven safe**: Creation can reorder windows. No background
 *   readiness claim.
 * - **Exclude invisible windows**: Arc enumerates closed window tombstones with
 *   visible:false — filter them out.
 * - **Stable IDs only**: Positional indices (window/space/tab) are ephemeral
 *   and must be resolved within each single AppleScript operation. Never store
 *   and reuse indices across calls.
 *
 * ## Capability boundary
 *
 * Supported: enumerate spaces/tabs, create tab (via marker), navigate, evaluate
 * JS (sync), close owned tab, DOM click/fill/scroll via evaluate.
 *
 * Unsupported (explicit errors): promises/async eval, trusted input, network
 * recording, uploads, PDF, console capture, screenshots (no tab select/activate).
 */

import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Capabilities of the native Arc backend. */
export interface ArcNativeCapabilities {
  /** Can create tabs via marker-based resolution. */
  createTab: boolean;
  /** Can navigate an owned tab. */
  navigate: boolean;
  /** Can execute synchronous JavaScript. */
  evaluateSync: boolean;
  /** Can close an owned tab. */
  closeTab: boolean;
  /** Can enumerate spaces and tabs. */
  enumerate: boolean;
  /** NOT supported: no tab activation for screenshots. */
  screenshot: false;
  /** NOT supported without implementation. */
  asyncEvaluate: false;
  /** NOT supported without implementation. */
  networkCapture: false;
  /** NOT supported without implementation. */
  consoleCapture: false;
  /** NOT supported without implementation. */
  upload: false;
  /** NOT supported without implementation. */
  pdf: false;
  /** NOT proven safe. */
  background: false;
}

export const ARC_NATIVE_CAPABILITIES: ArcNativeCapabilities = {
  createTab: true,
  navigate: true,
  evaluateSync: true,
  closeTab: true,
  enumerate: true,
  screenshot: false,
  asyncEvaluate: false,
  networkCapture: false,
  consoleCapture: false,
  upload: false,
  pdf: false,
  background: false,
};

/** A native Arc tab reference resolved by the driver. */
export interface ArcNativeTab {
  /** Window index (1-based, AppleScript convention). Ephemeral — valid only
   *  within the AppleScript call that produced it. */
  windowIndex: number;
  /** Space index within the window (1-based). */
  spaceIndex: number;
  /** Tab index within the space (1-based). */
  tabIndex: number;
  /** Tab URL at time of resolution. */
  url: string;
  /** Tab title at time of resolution. */
  title: string;
}

/** Result of creating a tab via the marker strategy. */
export interface ArcTabCreateResult {
  tab: ArcNativeTab;
  /** The unique marker URL used to identify the created tab. */
  markerUrl: string;
}

/** Error thrown when a native Arc capability is not supported. */
export class ArcNativeCapabilityError extends Error {
  constructor(
    public readonly capability: string,
    message?: string,
  ) {
    super(
      message ??
        `${capability} is unavailable for native Arc automation. ` +
          'This capability requires CDP (Chrome DevTools Protocol) which is not ' +
          'available for this Arc profile. Use a Chromium-family browser profile ' +
          'for this feature: agents browser profiles create <name> --browser comet',
    );
    this.name = 'ArcNativeCapabilityError';
  }
}

// ---------------------------------------------------------------------------
// AppleScript execution — async via child_process.spawn
// ---------------------------------------------------------------------------

/** Maximum time for any single AppleScript call. */
const OSASCRIPT_TIMEOUT_MS = 15_000;

/** Maximum stdout size (bytes) before aborting to avoid memory exhaustion. */
const OSASCRIPT_MAX_OUTPUT = 4 * 1024 * 1024; // 4 MiB

/**
 * Execute an AppleScript snippet via `osascript` stdin. Bounded by timeout
 * and output size. Async to avoid blocking the shared daemon event loop.
 *
 * Never uses `-ss` (source-strings quoting breaks result parsing).
 * Never uses shell — script is passed via stdin to avoid injection.
 */
export async function execAppleScript(
  script: string,
  timeoutMs = OSASCRIPT_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('osascript', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`osascript timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout!.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > OSASCRIPT_MAX_OUTPUT) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          reject(new Error(`osascript output exceeded ${OSASCRIPT_MAX_OUTPUT} bytes`));
        }
        return;
      }
      stdout += chunk.toString('utf-8');
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`osascript failed: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`osascript exited ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });

    // Write script to stdin and close the stream
    child.stdin!.write(script);
    child.stdin!.end();
  });
}

// ---------------------------------------------------------------------------
// Space and tab enumeration
// ---------------------------------------------------------------------------

/** Enumerate all spaces and their tabs in a running Arc instance. */
export interface ArcEnumeratedSpace {
  windowIndex: number;
  spaceIndex: number;
  spaceTitle: string;
  tabs: Array<{
    tabIndex: number;
    url: string;
    title: string;
  }>;
}

/**
 * Enumerate spaces and tabs from a running Arc browser.
 * Uses positional references only — never `whose id is`.
 *
 * Output uses tab character (`\t`) as field delimiter — URLs and titles
 * contain colons, so colon-delimited parsing is broken by `http://`.
 *
 * Excludes windows with `visible:false` — Arc enumerates closed window
 * tombstones that are not user-accessible.
 */
export async function enumerateArcSpaces(): Promise<ArcEnumeratedSpace[]> {
  // AppleScript uses `tab character` (or `ASCII character 9`) for the
  // tab delimiter. We use a line-oriented protocol with tab-separated fields.
  const script = `
tell application "Arc"
  set output to ""
  set wCount to count of windows
  repeat with wi from 1 to wCount
    set w to a reference to window wi
    if visible of w is true then
      set sCount to count of spaces of w
      repeat with si from 1 to sCount
        set s to a reference to space si of w
        set sTitle to title of s
        set tCount to count of tabs of s
        set output to output & "SPACE" & (ASCII character 9) & wi & (ASCII character 9) & si & (ASCII character 9) & sTitle & linefeed
        repeat with ti from 1 to tCount
          set t to a reference to tab ti of s
          set tUrl to URL of t
          set tTitle to title of t
          set output to output & "TAB" & (ASCII character 9) & wi & (ASCII character 9) & si & (ASCII character 9) & ti & (ASCII character 9) & tUrl & (ASCII character 9) & tTitle & linefeed
        end repeat
      end repeat
    end if
  end repeat
  return output
end tell`;

  const raw = await execAppleScript(script);
  const spaces: ArcEnumeratedSpace[] = [];
  const spaceMap = new Map<string, ArcEnumeratedSpace>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split('\t');
    const kind = fields[0];

    if (kind === 'SPACE' && fields.length >= 4) {
      const space: ArcEnumeratedSpace = {
        windowIndex: parseInt(fields[1]!, 10),
        spaceIndex: parseInt(fields[2]!, 10),
        spaceTitle: fields[3]!,
        tabs: [],
      };
      const key = `${space.windowIndex}\t${space.spaceIndex}`;
      spaceMap.set(key, space);
      spaces.push(space);
    } else if (kind === 'TAB' && fields.length >= 6) {
      const wi = parseInt(fields[1]!, 10);
      const si = parseInt(fields[2]!, 10);
      const ti = parseInt(fields[3]!, 10);
      const url = fields[4]!;
      // Title may contain tabs (unlikely but safe): rejoin remaining fields
      const title = fields.slice(5).join('\t');
      const space = spaceMap.get(`${wi}\t${si}`);
      if (space) {
        space.tabs.push({ tabIndex: ti, url, title });
      }
    }
  }

  return spaces;
}

// ---------------------------------------------------------------------------
// Tab creation via marker URL
// ---------------------------------------------------------------------------

/**
 * Create a new tab in a specific space using a unique marker URL, then resolve
 * the created tab by finding the marker.
 *
 * The marker strategy is required because Arc's `make new tab` returns a
 * malformed object reference (error -1700). Instead we:
 * 1. Create the tab with a unique data: URI marker
 * 2. Enumerate tabs to find the one with the exact marker URL
 * 3. Navigate it to the actual target URL
 *
 * The space is identified by `spaceTitle` (resolved to current ordinal within
 * the AppleScript call) rather than stored indices, because window/space
 * ordering can change between calls.
 */
export async function createArcTab(
  spaceTitle: string,
  targetUrl: string,
): Promise<ArcTabCreateResult> {
  const markerId = crypto.randomUUID();
  const marker = `data:text/html,<title>agents-marker-${markerId}</title>`;

  // Create tab and immediately resolve it by marker match — all in one
  // AppleScript call so indices don't shift between create and find.
  // Use tab delimiter for the result to avoid URL colon ambiguity.
  const script = `
tell application "Arc"
  -- Find the space by title in visible windows
  set foundSpace to missing value
  set foundWi to 0
  set foundSi to 0
  set wCount to count of windows
  repeat with wi from 1 to wCount
    set w to a reference to window wi
    if visible of w is true then
      set sCount to count of spaces of w
      repeat with si from 1 to sCount
        set s to a reference to space si of w
        if title of s is "${escapeAppleScriptString(spaceTitle)}" then
          set foundSpace to s
          set foundWi to wi
          set foundSi to si
          exit repeat
        end if
      end repeat
      if foundSpace is not missing value then exit repeat
    end if
  end repeat

  if foundSpace is missing value then
    error "Space not found: ${escapeAppleScriptString(spaceTitle)}"
  end if

  -- Create the tab with the marker URL
  make new tab in foundSpace with properties {URL:"${escapeAppleScriptString(marker)}"}
  delay 0.5

  -- Find the created tab by matching the exact marker URL
  set tCount to count of tabs of foundSpace
  repeat with ti from 1 to tCount
    set t to a reference to tab ti of foundSpace
    set tUrl to URL of t
    if tUrl is "${escapeAppleScriptString(marker)}" then
      return foundWi & (ASCII character 9) & foundSi & (ASCII character 9) & ti
    end if
  end repeat
  return "NOT_FOUND"
end tell`;

  const result = await execAppleScript(script);
  if (result === 'NOT_FOUND' || !result) {
    throw new Error(
      'Failed to resolve created Arc tab: marker URL not found after creation. ' +
        'The tab may have been created but could not be identified.',
    );
  }

  const parts = result.split('\t');
  const windowIndex = parseInt(parts[0]!, 10);
  const spaceIndex = parseInt(parts[1]!, 10);
  const tabIndex = parseInt(parts[2]!, 10);

  // Navigate the marker tab to the actual target URL
  if (targetUrl !== marker) {
    await navigateArcTab(spaceTitle, targetUrl);
  }

  return {
    tab: {
      windowIndex,
      spaceIndex,
      tabIndex,
      url: targetUrl,
      title: '',
    },
    markerUrl: marker,
  };
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

/**
 * Navigate a tab in a specified space to a URL. The tab is identified by
 * its URL (`tabUrl`) within the space, not by stored indices.
 *
 * When `tabUrl` is omitted, navigates the last tab in the space (the one
 * just created by createArcTab).
 */
export async function navigateArcTab(
  spaceTitle: string,
  url: string,
  tabUrl?: string,
): Promise<void> {
  const tabMatch = tabUrl
    ? `if URL of t is "${escapeAppleScriptString(tabUrl)}" then`
    : `if ti is tCount then`;
  const script = `
tell application "Arc"
  set wCount to count of windows
  repeat with wi from 1 to wCount
    set w to a reference to window wi
    if visible of w is true then
      set sCount to count of spaces of w
      repeat with si from 1 to sCount
        set s to a reference to space si of w
        if title of s is "${escapeAppleScriptString(spaceTitle)}" then
          set tCount to count of tabs of s
          repeat with ti from 1 to tCount
            set t to a reference to tab ti of s
            ${tabMatch}
              set URL of t to "${escapeAppleScriptString(url)}"
              return "OK"
            end if
          end repeat
          error "Tab not found in space ${escapeAppleScriptString(spaceTitle)}"
        end if
      end repeat
    end if
  end repeat
  error "Space not found: ${escapeAppleScriptString(spaceTitle)}"
end tell`;

  await execAppleScript(script);
}

// ---------------------------------------------------------------------------
// JavaScript execution
// ---------------------------------------------------------------------------

/**
 * Execute JavaScript in a tab identified by URL within a space, and return
 * the result.
 *
 * Runs in an ISOLATED WORLD — page globals are inaccessible. Return value is
 * an object envelope parsed directly from the AppleScript result (Arc serializes
 * once, so JSON.parse(raw) yields the object).
 *
 * Promises are unsupported and will fail honestly with an error rather than
 * hanging or returning a serialized Promise object.
 */
export async function executeJavaScript(
  spaceTitle: string,
  tabUrl: string,
  expression: string,
): Promise<unknown> {
  const script = `
tell application "Arc"
  set wCount to count of windows
  repeat with wi from 1 to wCount
    set w to a reference to window wi
    if visible of w is true then
      set sCount to count of spaces of w
      repeat with si from 1 to sCount
        set s to a reference to space si of w
        if title of s is "${escapeAppleScriptString(spaceTitle)}" then
          set tCount to count of tabs of s
          repeat with ti from 1 to tCount
            set t to a reference to tab ti of s
            if URL of t is "${escapeAppleScriptString(tabUrl)}" then
              set jsResult to execute javascript "${escapeAppleScriptString(expression)}" in t
              return jsResult
            end if
          end repeat
          error "Tab not found by URL in space ${escapeAppleScriptString(spaceTitle)}"
        end if
      end repeat
    end if
  end repeat
  error "Space not found: ${escapeAppleScriptString(spaceTitle)}"
end tell`;

  const raw = await execAppleScript(script);

  // Arc returns the result directly. For object results, the raw string is
  // JSON that should be parsed. For primitives, return as-is.
  if (raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'missing value') return undefined;

  // Try to parse as JSON (Arc serializes objects once)
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON — return as string
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Tab close
// ---------------------------------------------------------------------------

/**
 * Close a specific tab identified by its URL within a space.
 * Never closes tabs by stored index — indices shift when tabs are closed.
 */
export async function closeArcTab(
  spaceTitle: string,
  tabUrl: string,
): Promise<void> {
  const script = `
tell application "Arc"
  set wCount to count of windows
  repeat with wi from 1 to wCount
    set w to a reference to window wi
    if visible of w is true then
      set sCount to count of spaces of w
      repeat with si from 1 to sCount
        set s to a reference to space si of w
        if title of s is "${escapeAppleScriptString(spaceTitle)}" then
          set tCount to count of tabs of s
          repeat with ti from tCount to 1 by -1
            set t to a reference to tab ti of s
            if URL of t is "${escapeAppleScriptString(tabUrl)}" then
              close t
              return "OK"
            end if
          end repeat
          return "NOT_FOUND"
        end if
      end repeat
    end if
  end repeat
  return "NOT_FOUND"
end tell`;

  await execAppleScript(script);
}

// ---------------------------------------------------------------------------
// Tab resolution helpers
// ---------------------------------------------------------------------------

/**
 * Find a tab in a running Arc instance by URL substring match.
 * Returns the first match, or null.
 */
export async function findArcTabByUrl(
  urlSubstring: string,
  filterSpaceTitle?: string,
): Promise<ArcNativeTab | null> {
  const spaces = await enumerateArcSpaces();
  for (const space of spaces) {
    if (filterSpaceTitle && space.spaceTitle !== filterSpaceTitle) continue;
    for (const tab of space.tabs) {
      if (tab.url.includes(urlSubstring)) {
        return {
          windowIndex: space.windowIndex,
          spaceIndex: space.spaceIndex,
          tabIndex: tab.tabIndex,
          url: tab.url,
          title: tab.title,
        };
      }
    }
  }
  return null;
}

/**
 * Resolve a tab by its URL within a space. Validates that the tab still exists
 * by enumerating the live state.
 */
export async function resolveArcTabByUrl(
  spaceTitle: string,
  tabUrl: string,
): Promise<ArcNativeTab | null> {
  const spaces = await enumerateArcSpaces();
  for (const space of spaces) {
    if (space.spaceTitle !== spaceTitle) continue;
    for (const tab of space.tabs) {
      if (tab.url === tabUrl) {
        return {
          windowIndex: space.windowIndex,
          spaceIndex: space.spaceIndex,
          tabIndex: tab.tabIndex,
          url: tab.url,
          title: tab.title,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arc process check
// ---------------------------------------------------------------------------

/** Check if Arc is currently running. */
export async function isArcRunning(): Promise<boolean> {
  try {
    const result = await execAppleScript(
      'tell application "System Events" to return (name of processes) contains "Arc"',
    );
    return result === 'true';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for embedding in an AppleScript double-quoted string literal.
 * Handles backslashes, double quotes, and newlines.
 */
export function escapeAppleScriptString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
