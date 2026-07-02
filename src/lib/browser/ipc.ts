import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { IS_WINDOWS, ipcEndpoint } from '../platform/index.js';
import { getHelpersDir } from '../state.js';
import { BrowserService } from './service.js';
import { startDaemon, stopDaemon } from '../daemon.js';
import { getCliVersion } from '../version.js';
import type { IPCRequest, IPCResponse, RefNodeJson } from './types.js';

const SOCKET_NAME = 'browser.sock';

export interface IPCRequestOptions {
  autoStartDaemon?: boolean;
}

export class BrowserDaemonNotRunningError extends Error {
  constructor() {
    super(formatBrowserDaemonNotRunningError());
    this.name = 'BrowserDaemonNotRunningError';
  }
}

export function formatBrowserDaemonNotRunningError(): string {
  return [
    'Browser daemon not running.',
    'Start it with: agents browser start (auto-picks an installed browser)',
    'Or pin a profile: agents browser start --profile <name>',
    'List profiles: agents browser profiles list',
  ].join('\n');
}

export function getSocketPath(): string {
  return path.join(getHelpersDir(), 'browser', SOCKET_NAME);
}

/**
 * The address the daemon actually listens on / clients connect to: the unix
 * socket file on POSIX, a `\\.\pipe\` named pipe on Windows. `getSocketPath`
 * stays the canonical key (and the POSIX socket path); on Windows it's only used
 * to derive a stable pipe name, never touched on disk.
 */
function getIpcEndpoint(): string {
  return ipcEndpoint(getSocketPath());
}

/** Can we open a connection to the daemon right now? Resolves false on any
 * error. This is the authoritative liveness check on every platform: a live
 * daemon accepts the connection, while a stale POSIX socket file left behind by
 * a crashed daemon (or one that "appears and is immediately destroyed", #556)
 * rejects with ECONNREFUSED and is correctly reported as not reachable —
 * something fs.existsSync can't distinguish. */
function probeDaemon(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); finish(true); });
    sock.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

/** Is the daemon reachable? A real connect probe on every platform — a socket
 * file existing on disk is not proof a daemon is listening on it. */
export async function isDaemonReachable(): Promise<boolean> {
  return probeDaemon(getIpcEndpoint());
}

async function waitForSocket(_socketPath: string, timeoutMs: number): Promise<void> {
  const endpoint = getIpcEndpoint();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timeout waiting for browser daemon socket');
}

export class BrowserIPCServer {
  private server: net.Server | null = null;
  private service: BrowserService;

  constructor(service: BrowserService) {
    this.service = service;
  }

  async start(): Promise<void> {
    const socketPath = getSocketPath();
    const endpoint = getIpcEndpoint();
    const socketDir = path.dirname(socketPath);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

    if (!IS_WINDOWS) {
      fs.chmodSync(socketDir, 0o700);
      // Remove a stale unix socket from a prior crash. (Named pipes are not
      // filesystem objects and vanish with their owning process.)
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }

    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', async (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const request = JSON.parse(line) as IPCRequest;
            const response = await this.handleRequest(request);
            socket.write(JSON.stringify(response) + '\n');
          } catch (err) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            socket.write(JSON.stringify({ ok: false, error }) + '\n');
          }
        }
      });

      socket.on('error', () => {
        // Client disconnected
      });
    });

    return new Promise((resolve, reject) => {
      if (IS_WINDOWS) {
        // Windows named pipe: no umask/chmod — filesystem perms don't apply and
        // pipe ACLs default to the creating user.
        this.server!.listen(endpoint, () => resolve());
        this.server!.on('error', (err) => reject(err));
        return;
      }
      // Lock down the browser socket dir before opening the socket; on macOS
      // the parent dir is the real local-user boundary for AF_UNIX sockets.
      const prevUmask = process.umask(0o077);
      let restored = false;
      const restoreUmask = () => {
        if (restored) return;
        restored = true;
        process.umask(prevUmask);
      };
      this.server!.listen(socketPath, () => {
        try {
          fs.chmodSync(socketPath, 0o600);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          restoreUmask();
        }
      });
      this.server!.on('error', (err) => {
        restoreUmask();
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (!IS_WINDOWS) {
      const socketPath = getSocketPath();
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }

    await this.service.shutdown();
  }

  private async handleRequest(request: IPCRequest): Promise<IPCResponse> {
    if ((request.action as string) === 'upload-stage') {
      const source = (request as IPCRequest & { source?: string }).source;
      if (!source) {
        return { ok: false, error: 'Source required' };
      }
      const result = this.service.stageUpload(source);
      return { ok: true, path: result.path };
    }

    switch (request.action) {
      case 'version': {
        return { ok: true, version: getCliVersion() };
      }

      case 'start': {
        if (!request.profile) {
          return { ok: false, error: 'Profile required' };
        }
        const result = await this.service.start(request.profile, {
          taskName: request.taskName,
          url: request.url,
          endpointName: request.endpoint,
          skipDomainSkill: request.skipDomainSkill,
        });
        return {
          ok: true,
          task: result.name,
          tabId: result.tabId,
          windowTargetId: result.windowId,
          skill: result.skill,
        };
      }

      case 'done': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const result = await this.service.done(request.task);
        return { ok: result.ok, error: result.ok ? undefined : 'Task not found' };
      }

      case 'stop': {
        if (request.task) {
          const result = await this.service.stop(request.task);
          return { ok: result.ok, error: result.ok ? undefined : 'Task not found' };
        }
        if (request.profile) {
          await this.service.stopProfile(request.profile);
          return { ok: true };
        }
        return { ok: false, error: 'Task or profile required' };
      }

      case 'status': {
        const profiles = await this.service.status(request.profile);
        return { ok: true, profiles };
      }

      case 'history': {
        const history = await this.service.getHistory(request.limit ?? 10);
        return { ok: true, history };
      }

      case 'navigate': {
        if (!request.task || !request.url) {
          return { ok: false, error: 'Task and URL required' };
        }
        const result = await this.service.navigate(
          request.task,
          request.url,
          request.profile
        );
        return { ok: true, tabId: result.tabId };
      }

      case 'tab-add': {
        if (!request.task || !request.url) {
          return { ok: false, error: 'Task and URL required' };
        }
        const result = await this.service.tabAdd(request.task, request.url, request.profile);
        return { ok: true, tabId: result.tabId };
      }

      case 'tab-focus': {
        if (!request.task || !request.tabId) {
          return { ok: false, error: 'Task and tabId required' };
        }
        const result = await this.service.tabFocus(request.task, request.tabId);
        return { ok: true, tabId: result.tabId };
      }

      case 'tab-close': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        await this.service.tabClose(request.task, request.tabId);
        return { ok: true };
      }

      case 'tab-list': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const tabs = await this.service.tabList(request.task);
        return { ok: true, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, task: request.task! })) };
      }

      case 'evaluate': {
        if (!request.task || !request.expr) {
          return { ok: false, error: 'Task and expression required' };
        }
        const result = await this.service.evaluate(
          request.task,
          request.tabId,
          request.expr
        );
        return { ok: true, result };
      }

      case 'record-start': {
        if (!request.task) return { ok: false, error: 'Task required' };
        try {
          const r = await this.service.recordStart(request.task, request.tabId, {
            fps: request.fps,
            duration: request.duration,
            maxMb: request.maxMb,
          });
          return { ok: true, path: r.path, fps: r.fps, durationCapSec: r.durationCapSec, maxMb: r.maxMb };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'record-stop': {
        if (!request.task) return { ok: false, error: 'Task required' };
        try {
          const r = await this.service.recordStop(request.task);
          return { ok: true, path: r.path, bytes: r.bytes, durationMs: r.durationMs, stopReason: r.reason as 'manual' | 'duration-cap' | 'size-cap' };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'screenshot': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const shot = await this.service.screenshot(
          request.task,
          request.tabId,
          request.path,
          request.quality
        );
        return { ok: true, path: shot.path, bytes: shot.bytes, width: shot.width, height: shot.height };
      }

      case 'refs': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const { refs, nodeMap } = await this.service.refs(request.task, request.tabId, {
          interactive: request.interactive ?? true,
          limit: request.limit ?? 500,
        });
        const nodes: RefNodeJson[] = Array.from(nodeMap.values()).map(n => {
          const entry: RefNodeJson = { ref: n.ref, role: n.role, name: n.name, attrs: n.attrs };
          if (n.editor !== undefined) entry.editor = n.editor;
          return entry;
        });
        return { ok: true, refs, nodes };
      }

      case 'click': {
        if (!request.task || request.ref === undefined) {
          return { ok: false, error: 'Task and ref required' };
        }
        await this.service.click(request.task, request.ref, request.tabId);
        return { ok: true };
      }

      case 'type': {
        if (!request.task || request.ref === undefined || !request.text) {
          return { ok: false, error: 'Task, ref, and text required' };
        }
        await this.service.type(request.task, request.ref, request.text, request.tabId, request.clear);
        return { ok: true };
      }

      case 'press': {
        if (!request.task || !request.key) {
          return { ok: false, error: 'Task and key required' };
        }
        await this.service.press(request.task, request.key, request.tabId);
        return { ok: true };
      }

      case 'hover': {
        if (!request.task || request.ref === undefined) {
          return { ok: false, error: 'Task and ref required' };
        }
        await this.service.hover(request.task, request.ref, request.tabId);
        return { ok: true };
      }

      case 'scroll': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        await this.service.scroll(
          request.task,
          request.scrollX ?? 0,
          request.scrollY ?? 0,
          request.scrollAtX,
          request.scrollAtY,
          request.tabId
        );
        return { ok: true };
      }

      case 'set-viewport': {
        if (!request.task || !request.width || !request.height) {
          return { ok: false, error: 'Task, width, and height required' };
        }
        await this.service.setViewport(request.task, request.width, request.height, {
          mobile: request.mobile,
          deviceScaleFactor: request.deviceScaleFactor,
          tabHint: request.tabId,
        });
        return { ok: true };
      }

      case 'set-device': {
        if (!request.task || !request.deviceName) {
          return { ok: false, error: 'Task and device name required' };
        }
        await this.service.setDevice(request.task, request.deviceName, request.tabId);
        return { ok: true };
      }

      case 'console': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const logs = await this.service.getConsoleLogs(request.task, {
          level: request.level,
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, logs };
      }

      case 'errors': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const errors = await this.service.getErrors(request.task, {
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, errors };
      }

      case 'requests': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const requests = await this.service.getNetworkRequests(request.task, {
          filter: request.filter,
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, requests };
      }

      case 'response-body': {
        if (!request.task || !request.urlPattern) {
          return { ok: false, error: 'Task and URL pattern required' };
        }
        const body = await this.service.getResponseBody(request.task, request.urlPattern, {
          timeout: request.timeout,
          maxChars: request.maxChars,
          tabHint: request.tabId,
        });
        return { ok: true, body };
      }

      case 'wait': {
        if (!request.task || !request.waitType || request.waitValue === undefined) {
          return { ok: false, error: 'Task, wait type, and wait value required' };
        }
        await this.service.wait(request.task, request.waitType, request.waitValue, {
          timeout: request.timeout,
          tabHint: request.tabId,
        });
        return { ok: true };
      }

      case 'set-download-path': {
        if (!request.task || !request.downloadPath) {
          return { ok: false, error: 'Task and download path required' };
        }
        await this.service.setDownloadPath(request.task, request.downloadPath, request.tabId);
        return { ok: true };
      }

      case 'wait-download': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const downloadPath = await this.service.waitForDownload(request.task, request.timeout);
        return { ok: true, downloadPath };
      }

      case 'getAppLogs': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const appLogs = await this.service.getAppLogs(request.task, {
          lines: request.lines,
          level: request.appLevel,
          filter: request.filter,
          message: request.message,
          source: request.source,
          since: request.since,
          until: request.until,
        });
        return { ok: true, appLogs };
      }

      case 'upload': {
        if (!request.task || !request.files || request.files.length === 0) {
          return { ok: false, error: 'Task and at least one file required' };
        }
        const result = await this.service.upload(request.task, request.files, {
          ref: request.ref,
          trigger: request.trigger,
          mode: request.uploadMode,
          tabHint: request.tabId,
          timeout: request.timeout,
        });
        return { ok: true, uploadMode: result.mode };
      }

      default:
        return { ok: false, error: `Unknown action: ${request.action}` };
    }
  }
}

let versionReconciledThisProcess = false;

/**
 * Decide whether a running daemon is stale and must be restarted. A daemon
 * is stale when it reports a concrete version that differs from this CLI's.
 * `undefined`/`'unknown'` means the daemon is too old to answer the `version`
 * action reliably — don't churn it on that ambiguous signal.
 */
export function shouldRestartStaleDaemon(
  daemonVersion: string | undefined,
  clientVersion: string
): boolean {
  if (!daemonVersion || daemonVersion === 'unknown') return false;
  return daemonVersion !== clientVersion;
}

/**
 * Reconcile the running daemon's version with ours. If the daemon is serving
 * stale code, stop and restart it so this request — and the rest of the
 * session — runs the current build. Runs at most once per CLI process. The
 * whole reason this exists: a launchd-managed daemon kept serving stale code
 * to a dev-build CLI for an entire session and nothing surfaced it (#291).
 */
async function reconcileDaemonVersion(socketPath: string): Promise<void> {
  if (versionReconciledThisProcess) return;
  versionReconciledThisProcess = true;

  let daemon: string | undefined;
  try {
    const resp = await sendRawIPCRequest({ action: 'version' }, { autoStartDaemon: false });
    daemon = resp.version;
  } catch {
    // Daemon unreachable or too old to speak 'version' — leave it alone.
    return;
  }

  const client = getCliVersion();
  if (!shouldRestartStaleDaemon(daemon, client)) return;

  process.stderr.write(
    `\nbrowser daemon was on ${daemon}, this CLI is on ${client} — restarting it to load current code.\n\n`
  );
  stopDaemon();
  startDaemon();
  if (!(await isDaemonReachable())) {
    await waitForSocket(socketPath, 6000);
  }
  await new Promise((r) => setTimeout(r, 300));
}

export async function sendIPCRequest(
  request: IPCRequest,
  opts: IPCRequestOptions = {}
): Promise<IPCResponse> {
  return sendRawIPCRequest(request, opts);
}

async function sendRawIPCRequest(
  request: IPCRequest,
  opts: IPCRequestOptions = {}
): Promise<IPCResponse> {
  const socketPath = getSocketPath();
  const endpoint = getIpcEndpoint();
  const autoStartDaemon = opts.autoStartDaemon ?? true;

  if (!(await isDaemonReachable())) {
    if (!autoStartDaemon) {
      throw new BrowserDaemonNotRunningError();
    }
    if (!IS_WINDOWS) {
      await fs.promises.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await fs.promises.chmod(path.dirname(socketPath), 0o700);
    }
    startDaemon();
    if (!(await isDaemonReachable())) {
      await waitForSocket(socketPath, 6000);
    }
    if (!(await isDaemonReachable())) {
      throw new Error('Failed to start browser daemon');
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Before serving a real request, make sure the daemon isn't running stale
  // code. Skips the internal `version` probe (avoids recursion) and callers
  // that opt out of auto-start. No-ops once reconciled or when versions match.
  if (request.action !== 'version' && autoStartDaemon) {
    await reconcileDaemonVersion(socketPath);
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const response = JSON.parse(buffer.slice(0, idx)) as IPCResponse;
        socket.end();
        resolve(response);
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!autoStartDaemon && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
        reject(new BrowserDaemonNotRunningError());
        return;
      }
      reject(new Error(`IPC error: ${err.message}`));
    });

    socket.on('close', () => {
      if (!buffer.includes('\n')) {
        reject(new Error('Connection closed before response'));
      }
    });
  });
}
