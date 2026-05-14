import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { getHelpersDir } from '../state.js';
import { BrowserService } from './service.js';
import { startDaemon } from '../daemon.js';
import { getCliVersion } from '../version.js';
import type { IPCRequest, IPCResponse, RefNodeJson } from './types.js';

const SOCKET_NAME = 'browser.sock';

export function getSocketPath(): string {
  return path.join(getHelpersDir(), SOCKET_NAME);
}

export class BrowserIPCServer {
  private server: net.Server | null = null;
  private service: BrowserService;

  constructor(service: BrowserService) {
    this.service = service;
  }

  async start(): Promise<void> {
    const socketPath = getSocketPath();

    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
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
      this.server!.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    const socketPath = getSocketPath();
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    await this.service.shutdown();
  }

  private async handleRequest(request: IPCRequest): Promise<IPCResponse> {
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
        });
        return {
          ok: true,
          task: result.name,
          tabId: result.tabId,
          windowTargetId: result.windowId,
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

let versionCheckedThisProcess = false;

/**
 * Check the daemon's version against ours and warn loudly when they
 * differ. Fires at most once per CLI process — successive calls in the
 * same `agents browser ...` invocation are cheap. The whole reason this
 * code exists: a launchd-managed registry daemon kept serving stale code
 * to a dev-build CLI for an entire session and nothing surfaced it.
 */
async function maybeWarnVersionMismatch(): Promise<void> {
  if (versionCheckedThisProcess) return;
  versionCheckedThisProcess = true;
  try {
    const resp = await sendRawIPCRequest({ action: 'version' });
    const daemon = resp.version;
    const client = getCliVersion();
    if (!daemon || daemon === 'unknown' || daemon === client) return;
    process.stderr.write(
      `\nwarning: browser daemon is on ${daemon} but this CLI is on ${client}.\n` +
        `         Run \`agents daemon restart\` to load the current code.\n\n`
    );
  } catch {
    // daemon might be an older build that doesn't speak 'version' — that's
    // itself a hint, but a noisy one. Stay silent on this path.
  }
}

export async function sendIPCRequest(request: IPCRequest): Promise<IPCResponse> {
  const result = await sendRawIPCRequest(request);
  // Run the version check after the user's request returns — keeps the
  // critical path zero-overhead and ensures `start` doesn't get blocked
  // on a daemon-restart warning that the user hasn't read yet.
  if (request.action !== 'version') {
    maybeWarnVersionMismatch().catch(() => {});
  }
  return result;
}

async function sendRawIPCRequest(request: IPCRequest): Promise<IPCResponse> {
  const socketPath = getSocketPath();

  if (!fs.existsSync(socketPath)) {
    await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
    startDaemon();
    if (!fs.existsSync(socketPath)) {
      await new Promise<void>((resolve, reject) => {
        const socketDir = path.dirname(socketPath);
        const socketName = path.basename(socketPath);
        const watcher = fs.watch(socketDir, (_event, file) => {
          if (file === socketName) {
            clearTimeout(timeout);
            watcher.close();
            resolve();
          }
        });
        watcher.on('error', (error) => {
          clearTimeout(timeout);
          watcher.close();
          reject(error);
        });
        const timeout = setTimeout(() => {
          watcher.close();
          reject(new Error('Timeout waiting for browser daemon socket'));
        }, 6000);

        if (fs.existsSync(socketPath)) {
          clearTimeout(timeout);
          watcher.close();
          resolve();
        }
      });
    }
    if (!fs.existsSync(socketPath)) {
      throw new Error('Failed to start browser daemon');
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
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

    socket.on('error', (err) => {
      reject(new Error(`IPC error: ${err.message}`));
    });

    socket.on('close', () => {
      if (!buffer.includes('\n')) {
        reject(new Error('Connection closed before response'));
      }
    });
  });
}
