/**
 * PTY Client
 *
 * Thin client that connects to the PTY sidecar server over unix socket.
 * Each call opens a connection, sends a JSON request, reads the JSON response, and closes.
 */

import * as net from 'net';
import * as fs from 'fs';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';
import { getSocketPath, getPtyPidPath, getPtyLogPath, isPtyServerRunning } from './pty-server.js';
import { backgroundSpawnOptions } from './platform/process.js';

const CONNECT_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 30000;
const IS_WINDOWS = process.platform === 'win32';

/** JSON response envelope from the PTY server. */
export interface PtyResponse {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

/**
 * Send a request to the PTY server and return the response.
 * Auto-starts the server if not running.
 */
export async function ptyRequest(action: string, id?: string, params?: Record<string, any>): Promise<PtyResponse> {
  await ensureServer();

  const req: any = { action };
  if (id) req.id = id;
  if (params) req.params = params;

  return sendRequest(req);
}

/**
 * Ensure the PTY server is running. Start it if not.
 */
async function ensureServer(): Promise<void> {
  if (isPtyServerRunning()) return;

  // Find the entry point to spawn the server
  const { bin, args } = getServerSpawnArgs();

  const logPath = getPtyLogPath();
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(bin, args, {
    stdio: ['ignore', logFd, logFd],
    ...backgroundSpawnOptions({ fdStdio: true }),
  });
  child.unref();
  fs.closeSync(logFd);

  // Wait for the server to become reachable. On Unix the socket file appearing is
  // a cheap readiness signal; on Windows the named pipe is not a filesystem object
  // (fs.existsSync always returns false), so we just attempt the ping directly.
  const socketPath = getSocketPath();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (IS_WINDOWS || fs.existsSync(socketPath)) {
      // Verify we can connect
      try {
        await sendRequest({ action: 'ping' });
        return;
      } catch {
        // Not ready yet
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }

  throw new Error('PTY server failed to start within 5 seconds. Check ~/.agents/.system/helpers/pty/logs.jsonl');
}

function getServerSpawnArgs(): { bin: string; args: string[] } {
  // Prefer the dist/index.js from the same installation as this code.
  // This avoids version mismatch when a globally installed `agents` is older.
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const distIndex = path.join(__dirname, '..', 'index.js');
    if (fs.existsSync(distIndex)) {
      return { bin: process.execPath, args: [distIndex, 'pty', '_server'] };
    }
  } catch {}

  // Fallback: use the globally installed agents command. `which` is Unix-only;
  // Windows uses `where`, which can return multiple lines — take the first.
  try {
    const lookup = IS_WINDOWS ? 'where agents' : 'which agents';
    const agentsBin = execSync(lookup, { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    if (agentsBin) {
      return { bin: agentsBin, args: ['pty', '_server'] };
    }
  } catch {}

  return { bin: 'agents', args: ['pty', '_server'] };
}

/**
 * Send a JSON request over the unix socket and return the parsed response.
 */
function sendRequest(req: any): Promise<PtyResponse> {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();

    // On Unix a missing socket file means the server isn't up — fail fast with a
    // clear message. On Windows the named pipe isn't a filesystem object, so we
    // skip the probe and let createConnection surface ENOENT/connection errors.
    if (!IS_WINDOWS && !fs.existsSync(socketPath)) {
      reject(new Error('PTY server socket not found. Is the server running?'));
      return;
    }

    const conn = net.createConnection({ path: socketPath });
    let data = '';
    let settled = false;

    const connectTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        reject(new Error('Connection to PTY server timed out'));
      }
    }, CONNECT_TIMEOUT_MS);

    const responseTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        reject(new Error('PTY server response timed out'));
      }
    }, RESPONSE_TIMEOUT_MS);

    conn.on('connect', () => {
      clearTimeout(connectTimeout);
      conn.write(JSON.stringify(req) + '\n');
    });

    conn.on('data', (chunk) => {
      data += chunk.toString();
      const nlIndex = data.indexOf('\n');
      if (nlIndex !== -1) {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimeout);
          clearTimeout(responseTimeout);
          try {
            resolve(JSON.parse(data.slice(0, nlIndex)));
          } catch (err) {
            reject(new Error(`Invalid JSON from PTY server: ${data.slice(0, 200)}`));
          }
        }
        conn.end();
      }
    });

    conn.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimeout);
        clearTimeout(responseTimeout);
        reject(new Error(`PTY server connection error: ${err.message}`));
      }
    });

    conn.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimeout);
        clearTimeout(responseTimeout);
        if (data.trim()) {
          try {
            resolve(JSON.parse(data.trim()));
          } catch {
            reject(new Error('PTY server closed connection with invalid response'));
          }
        } else {
          reject(new Error('PTY server closed connection without response'));
        }
      }
    });
  });
}

/**
 * Parse escape sequences in user input strings.
 * Handles: \n \r \t \e \xHH \\
 */
export function unescapeInput(input: string): string {
  return input.replace(/\\(n|r|t|e|\\|x[0-9a-fA-F]{2})/g, (match, seq) => {
    switch (seq) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'e': return '\x1b';
      case '\\': return '\\';
      default:
        // \xHH
        if (seq.startsWith('x')) {
          return String.fromCharCode(parseInt(seq.slice(1), 16));
        }
        return match;
    }
  });
}
