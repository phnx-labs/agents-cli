export type BrowserType = 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'custom';

export interface BrowserProfile {
  name: string;
  description?: string;
  browser: BrowserType;
  binary?: string;
  endpoints: string[];
  chrome?: ChromeOptions;
  secrets?: string;
  viewport?: { width: number; height: number };
}

export interface ChromeOptions {
  headless?: boolean;
  args?: string[];
}

export interface Task {
  id: string;
  profile: string;
  windowTargetId?: string;
  tabIds: string[];
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
  tasks: TaskStatus[];
}

export interface TaskStatus {
  id: string;
  tabCount: number;
  createdAt: number;
}

export type IPCAction =
  | 'start'
  | 'stop'
  | 'status'
  | 'navigate'
  | 'tabs'
  | 'close'
  | 'evaluate'
  | 'screenshot'
  | 'refs'
  | 'click'
  | 'type'
  | 'press'
  | 'hover';

export interface IPCRequest {
  action: IPCAction;
  task?: string;
  profile?: string;
  url?: string;
  tabId?: string;
  expr?: string;
  path?: string;
  ref?: number;
  text?: string;
  key?: string;
  interactive?: boolean;
  limit?: number;
}

export interface IPCResponse {
  ok: boolean;
  error?: string;
  task?: string;
  tabId?: string;
  windowTargetId?: string;
  tabs?: TabInfo[];
  profiles?: ProfileStatus[];
  result?: unknown;
  path?: string;
  refs?: string;
}

export const TASK_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_REGEX.test(id) && id.length <= 64;
}

export function generateTaskId(): string {
  return crypto.randomUUID().slice(0, 8);
}
