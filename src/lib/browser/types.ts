export type BrowserType = 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'custom';

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
  endpoints: string[];
  chrome?: ChromeOptions;
  secrets?: string;
  viewport?: { width: number; height: number; x?: number; y?: number };
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
  | 'launch-profile'
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
  | 'wait-download';

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
  refs?: string;
  port?: number;
  pid?: number;
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
];

const NOUNS = [
  'falcon', 'comet', 'tiger', 'nebula', 'phoenix', 'river', 'summit', 'wave',
  'aurora', 'breeze', 'crystal', 'dragon', 'ember', 'forest', 'glacier', 'harbor',
];

export function generateFunName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}
