export type BrowserType = 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'custom';

/**
 * A single named endpoint preset within a profile. Lets one profile cover
 * the local + remote variants of the same app (e.g. an Electron app on this
 * Mac vs. on a remote host) instead of forcing two parallel profiles.
 *
 * Per-endpoint overrides take precedence over profile-level fields.
 */
export interface EndpointPreset {
  /**
   * CDP URL — `cdp://host:port` or `ssh://host?port=N`.
   *
   * For an SSH target whose remote is Windows, append `&os=windows` (e.g.
   * `ssh://user@host?port=9222&os=windows`). The driver then speaks the
   * Windows dialect (launch via WMI Win32_Process.Create so the browser
   * survives the ssh session, teardown via Get-NetTCPConnection/Stop-Process)
   * instead of the POSIX default. The query param is the single source of
   * truth for remote-OS selection.
   */
  target: string;
  /** Override the profile-level binary (e.g. a remote host has no local binary). */
  binary?: string;
  /** Override the profile-level targetFilter (Electron app builds may diverge). */
  targetFilter?: string;
}

export interface BrowserProfile {
  name: string;
  description?: string;
  browser: BrowserType;
  binary?: string;
  electron?: boolean;
  /**
   * `url:<substring>` or `title:<substring>`. Picks which CDP page target
   * represents the visible UI for Electron apps with multiple WebContents.
   */
  targetFilter?: string;
  /**
   * Endpoint presets. Accepts two shapes for backward compatibility:
   *   - Legacy: `string[]` of CDP URLs; first entry is the default.
   *   - New:    `{ [presetName]: EndpointPreset }`, with optional `defaultEndpoint`.
   * Normalize via `resolveEndpoint(profile, name?)` instead of reading directly.
   */
  endpoints: string[] | Record<string, EndpointPreset>;
  defaultEndpoint?: string;
  chrome?: ChromeOptions;
  secrets?: string;
  viewport?: { width: number; height: number; x?: number; y?: number };
  /** Directory holding source-side JSONL logs (e.g. ~/.rush/logs). */
  logDir?: string;
  /** Optional SSH host where logDir lives, e.g. "user@remote-host". */
  logHost?: string;
}

/** Parsed form of `BrowserProfile.targetFilter`. */
export interface TargetFilter {
  kind: 'url' | 'title';
  value: string;
}

export interface ChromeOptions {
  headless?: boolean;
  args?: string[];
  viewport?: { width: number; height: number; x?: number; y?: number };
}

export interface Task {
  id: string;
  name: string;
  profile: string;
  tabs: Record<string, string>; // shortId (8 chars) -> CDP targetId
  currentTabId?: string; // shortId of current tab
  createdAt: number;
  pid: number;
  /**
   * Per-tab snapshot of the last ref descriptors captured for that tab
   * (shortId -> descriptors). Persisted to tasks.json so a later `click <ref>`
   * can self-heal a drifted ref by matching (role,name). See RefDescriptor.
   */
  refDescriptors?: Record<string, import('./refs.js').RefDescriptor[]>;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  task: string;
}

export interface ProfileStatus {
  name: string;
  running: boolean;
  port?: number;
  pid?: number;
  /** The port declared in the profile's first endpoint, when it differs from the running port. */
  configuredPort?: number;
  tasks: TaskStatus[];
}

export interface TaskStatus {
  id: string;
  name: string;
  tabCount: number;
  currentTabId?: string;
  createdAt: number;
  endedAt?: number;
  domains?: string[];
  tabs?: Array<{ id: string; url: string; title?: string; current?: boolean }>;
}

export interface HistoricalTask {
  id: string;
  name: string;
  profile: string;
  createdAt: number;
  endedAt: number;
  domains: string[];
  tabCount: number;
}

export type IPCAction =
  | 'start'
  | 'record-start'
  | 'record-stop'
  | 'done'
  | 'stop'
  | 'status'
  | 'history'
  | 'navigate'
  | 'tab-add'
  | 'tab-focus'
  | 'tab-close'
  | 'tab-list'
  | 'evaluate'
  | 'screenshot'
  | 'pdf'
  | 'refs'
  | 'click'
  | 'type'
  | 'press'
  | 'hover'
  | 'scroll'
  | 'set-viewport'
  | 'set-device'
  | 'console'
  | 'errors'
  | 'requests'
  | 'response-body'
  | 'wait'
  | 'set-download-path'
  | 'wait-download'
  | 'upload'
  | 'getAppLogs'
  | 'version';

export interface IPCRequest {
  action: IPCAction;
  task?: string;
  taskName?: string; // human-readable task name for 'open'
  profile?: string;
  url?: string;
  tabId?: string;
  expr?: string;
  path?: string;
  ref?: number;
  // Coordinate click (`browser click --at X,Y`): bypasses ref resolution.
  atX?: number;
  atY?: number;
  text?: string;
  key?: string;
  scrollX?: number;
  scrollY?: number;
  scrollAtX?: number;
  scrollAtY?: number;
  interactive?: boolean;
  limit?: number;
  // Viewport/device
  width?: number;
  height?: number;
  deviceName?: string;
  mobile?: boolean;
  deviceScaleFactor?: number;
  // Console/errors
  level?: 'log' | 'info' | 'warn' | 'error';
  clear?: boolean;
  // Network
  filter?: string;
  urlPattern?: string;
  maxChars?: number;
  // Wait
  waitType?: 'time' | 'selector' | 'url' | 'function' | 'load';
  waitValue?: string | number;
  timeout?: number;
  // Downloads
  downloadPath?: string;
  // Upload
  files?: string[];
  trigger?: number;
  uploadMode?: 'auto' | 'input' | 'drop' | 'chooser';
  // Screenshot
  quality?: 'compressed' | 'raw';
  // Endpoint preset
  endpoint?: string;
  // Recording
  fps?: number;
  duration?: number;
  maxMb?: number;
  // App logs
  source?: string;
  lines?: number;
  message?: string;
  since?: string;
  until?: string;
  appLevel?: string;
  // Browser start: opt out of domain-skill discovery.
  skipDomainSkill?: boolean;
}

/** Subset of IPCResponse describing a recording start result. */
export interface RecordStartFields {
  fps?: number;
  durationCapSec?: number;
  maxMb?: number;
}

/** Subset of IPCResponse describing a recording stop result. */
export interface RecordStopFields {
  durationMs?: number;
  stopReason?: 'manual' | 'duration-cap' | 'size-cap';
}

export interface IPCResponse {
  ok: boolean;
  error?: string;
  task?: string;
  tabId?: string;
  windowTargetId?: string;
  tabs?: TabInfo[];
  profiles?: ProfileStatus[];
  history?: HistoricalTask[];
  result?: unknown;
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  refs?: string;
  nodes?: RefNodeJson[];
  /** Human-readable note surfaced to the CLI (e.g. a self-heal notice on click). */
  message?: string;
  port?: number;
  pid?: number;
  // Recording
  fps?: number;
  durationCapSec?: number;
  maxMb?: number;
  durationMs?: number;
  stopReason?: 'manual' | 'duration-cap' | 'size-cap';
  // Console/errors
  logs?: ConsoleEntry[];
  errors?: ErrorEntry[];
  // Network
  requests?: NetworkRequest[];
  body?: string;
  // Downloads
  downloadPath?: string;
  // Devices
  devices?: string[];
  // Upload
  uploadMode?: 'input' | 'drop' | 'chooser';
  // App logs
  appLogs?: any[];
  // Version handshake — daemon answers with the package version it was
  // built from so the client can warn when the daemon is older than the
  // caller (the failure mode that produced this whole patch series: a
  // launchd-managed registry daemon silently serving old code to a
  // dev-build CLI client).
  version?: string;
  // Domain-skill auto-discovery result from `start` when a URL is supplied
  // and a matching SKILL.md was found under
  // ~/.agents/skills/browser/domain-skills/.
  skill?: {
    name: string;
    path: string;
    content: string;
    hostname: string;
  };
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  timestamp: number;
  url?: string;
  line?: number;
}

export interface ErrorEntry {
  message: string;
  stack?: string;
  timestamp: number;
  url?: string;
  line?: number;
}

export interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  timestamp: number;
}

export interface RefNodeJson {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  editor?: string;
}

export interface DeviceDescriptor {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export const TASK_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_REGEX.test(id) && id.length <= 64;
}

export function generateTaskId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function generateShortId(): string {
  return crypto.randomUUID().split('-')[0]; // 8 chars
}

const ADJECTIVES = [
  'swift', 'cosmic', 'jolly', 'quiet', 'bold', 'bright', 'calm', 'eager',
  'golden', 'happy', 'keen', 'lucky', 'noble', 'proud', 'quick', 'royal',
  'silver', 'amber', 'crimson', 'misty', 'sunny', 'gentle', 'wild', 'brave',
  'merry', 'sleek', 'wise', 'fierce', 'curious', 'humble', 'spry', 'witty',
];

const NOUNS = [
  'falcon', 'comet', 'tiger', 'nebula', 'phoenix', 'river', 'summit', 'wave',
  'aurora', 'breeze', 'crystal', 'dragon', 'ember', 'forest', 'glacier', 'harbor',
  'crab', 'otter', 'hawk', 'fox', 'wolf', 'panda', 'lynx', 'raven',
  'meadow', 'canyon', 'valley', 'orchid', 'cedar', 'thistle', 'lotus', 'briar',
];

export function generateFunName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

/**
 * Auto-generated task name: `<adjective>-<noun>-<noun>-<hex8>`, e.g.
 * `swift-crab-falcon-a3f92b1c`. Three English words make it memorable and
 * easy to read; 32 bits of hex give every spawned task enough entropy that
 * parallel agents never collide on the daemon side.
 */
export function generateTaskName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun1 = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  let noun2 = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  while (noun2 === noun1) {
    noun2 = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  }
  const hex8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${adj}-${noun1}-${noun2}-${hex8}`;
}
