/**
 * PTY Sidecar Server
 *
 * Lightweight unix socket server that manages persistent PTY sessions.
 * Started as a detached process by `agents pty` commands. Sessions survive
 * across multiple CLI invocations. Each session holds a real PTY (via node-pty)
 * and a headless terminal emulator (via @xterm/headless) for screen rendering.
 *
 * Protocol: newline-delimited JSON over ~/.agents/.system/pty.sock
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getPtyDir as getPtyDirRoot } from './state.js';
import { isAlive } from './platform/index.js';

/**
 * Capture a stable identifier for a process at the moment it was started.
 * Used to defeat PID reuse: a kill(pid, ...) is only safe when the process
 * still occupies the PID we observed at spawn time.
 *
 * Linux:  field 22 of /proc/<pid>/stat (starttime in clock ticks since boot).
 * macOS:  output of `ps -o lstart= -p <pid>` (start time in human format).
 * Returns null on any error so callers can skip the guard rather than crash.
 */
export function captureProcessStartTime(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // The comm field (#2) is wrapped in parens and may contain spaces, so
      // split off everything after the last `)` to get a clean field list.
      const lastParen = stat.lastIndexOf(')');
      if (lastParen < 0) return null;
      const tail = stat.slice(lastParen + 2);
      const fields = tail.split(' ');
      // After comm we are at field 3; starttime is field 22, so index 19 here.
      return fields[19] || null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// --- Constants ---

const IS_WINDOWS = process.platform === 'win32';
const SENTINEL = '__AGENTS_PTY_DONE__';
const SOCKET_NAME = 'pty.sock';
const PID_FILE = 'pty.pid';
const LOG_FILE = 'logs.jsonl';
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const LOG_ROTATE_COUNT = 3;
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 min
const SERVER_IDLE_MS = 60 * 60 * 1000;  // 1 hour

// --- Types ---

interface Session {
  id: string;
  pty: any;
  terminal: any;
  rows: number;
  cols: number;
  shell: string;
  cwd: string;
  pid: number;
  startTime: string | null;
  startedAt: number;
  lastActivity: number;
  pendingOutput: string;
  appActive: boolean;
  activeCommand: string;
  exited: boolean;
  exitCode: number | null;
}

// --- Path helpers ---

/** Env vars forwarded into PTY sessions. Excludes API tokens, cloud creds, etc. */
const PTY_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME',
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'TMPDIR',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'NODE_PATH', 'NVM_DIR', 'BUN_INSTALL',
  'EDITOR', 'VISUAL', 'PAGER', 'LESS',
  'NO_COLOR', 'FORCE_COLOR',
];

/**
 * Windows allowlist. cmd.exe / PowerShell refuse to start (or misbehave) without
 * SystemRoot, ComSpec, PATHEXT and the USERPROFILE/APPDATA family, so a Unix-style
 * allowlist would spawn a broken shell. PATH/TERM/color/NODE vars are shared with
 * the Unix list; the rest are Windows-specific.
 */
const PTY_ENV_ALLOWLIST_WIN = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'NODE_PATH', 'BUN_INSTALL',
];

function buildPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const allowlist = IS_WINDOWS ? PTY_ENV_ALLOWLIST_WIN : PTY_ENV_ALLOWLIST;
  for (const key of allowlist) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

/**
 * Wrap a user command so a `__SENTINEL__:<exit>` line is printed after it
 * finishes — that line drives completion detection in the exec/read flow.
 * The separator and exit-code variable are shell-family specific:
 *   POSIX sh/zsh/bash : `cmd; echo "S:$?"`
 *   PowerShell        : `cmd; echo "S:$LASTEXITCODE"`
 *   cmd.exe           : `cmd & echo S:%errorlevel%`  (`&` always runs the echo)
 * Only the completion marker matters; the numeric exit code is informational
 * (the authoritative code comes from node-pty's onExit).
 */
export function buildSentinelCommand(shell: string, command: string): string {
  // Split on both separators: a Windows shell path (`C:\…\cmd.exe`) must be
  // recognized even when this code runs under POSIX path.basename, which does
  // not treat `\` as a separator.
  const name = (shell.split(/[\\/]/).pop() || shell).toLowerCase();
  if (name === 'cmd.exe' || name === 'cmd') {
    return `${command} & echo ${SENTINEL}:%errorlevel%`;
  }
  if (name === 'powershell.exe' || name === 'powershell' || name === 'pwsh.exe' || name === 'pwsh') {
    return `${command}; echo "${SENTINEL}:$LASTEXITCODE"`;
  }
  return `${command}; echo "${SENTINEL}:$?"`;
}

/** Get the PTY helper directory, creating it if needed. */
function getPtyDir(): string {
  const dir = getPtyDirRoot();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the IPC endpoint for a given platform + PTY scratch dir. Pure so both
 * branches are testable without stubbing process.platform.
 *
 * Unix: an AF_UNIX socket file inside the scratch dir.
 * Windows: a named pipe (`\\.\pipe\…`). Named pipes are NOT filesystem objects,
 * so the name is derived from a hash of the (per-user) scratch dir to keep it
 * stable across invocations and isolated per user — and callers must never probe
 * it with fs.existsSync (it always reports false). Both forms are accepted by
 * net.createServer/createConnection.
 */
export function derivePtyEndpoint(platform: NodeJS.Platform, ptyDir: string): string {
  if (platform === 'win32') {
    const hash = crypto.createHash('sha1').update(ptyDir).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\agents-pty-${hash}`;
  }
  return path.join(ptyDir, SOCKET_NAME);
}

/** Get the IPC endpoint the PTY server listens on / clients connect to. */
export function getSocketPath(): string {
  return derivePtyEndpoint(process.platform, getPtyDir());
}

/** Get the path to the PTY server PID file. */
export function getPtyPidPath(): string {
  return path.join(getPtyDir(), PID_FILE);
}

/** Get the path to the PTY server log file. */
export function getPtyLogPath(): string {
  const logDir = getPtyDir();
  return path.join(logDir, LOG_FILE);
}

/** Check if the PTY server process is alive by probing the stored PID. */
export function isPtyServerRunning(): boolean {
  const pidPath = getPtyPidPath();
  if (!fs.existsSync(pidPath)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    if (isAlive(pid)) return true;
  } catch {
    // read failed — fall through and treat the pid file as stale
  }
  try { fs.unlinkSync(pidPath); } catch {}
  return false;
}

// --- Logging ---

function rotateLogsIfNeeded(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < LOG_MAX_SIZE) return;
    for (let i = LOG_ROTATE_COUNT - 1; i >= 1; i--) {
      const older = `${logPath}.${i}`;
      const newer = i === 1 ? logPath : `${logPath}.${i - 1}`;
      if (fs.existsSync(newer)) {
        fs.renameSync(newer, older);
      }
    }
    if (fs.existsSync(logPath)) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {}
}

function log(level: string, message: string): void {
  const logPath = getPtyLogPath();
  rotateLogsIfNeeded(logPath);
  const entry = { ts: new Date().toISOString(), level, message };
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {}
}

// --- Server ---

/** Start the PTY sidecar server, listening on the unix socket for JSON requests. */
export async function runPtyServer(): Promise<void> {
  // Dynamic imports for optional native deps
  let nodePty: any;
  let XtermTerminal: any;

  try {
    // The Homebridge multiarch fork of node-pty: API-identical (same 1.x N-API
    // codebase) but ships prebuilt binaries for Linux glibc + musl, x64 + arm64
    // (plus macOS/Windows), so no compiler is needed on Linux/Alpine/arm64.
    nodePty = await import('@homebridge/node-pty-prebuilt-multiarch');
    // Handle ESM default export
    if (nodePty.default?.spawn) nodePty = nodePty.default;

    // Ensure spawn-helper is executable (bun install doesn't set +x on prebuilds)
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const ptyBase = path.resolve(__dirname, '..', '..', 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');
      const helpers = [
        path.join(ptyBase, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
        path.join(ptyBase, 'build', 'Release', 'spawn-helper'),
      ];
      for (const h of helpers) {
        if (fs.existsSync(h)) {
          fs.chmodSync(h, 0o755);
        }
      }
    } catch {}
  } catch (err) {
    console.error('node-pty (@homebridge/node-pty-prebuilt-multiarch) is required for PTY support.');
    console.error('Install: bun add @homebridge/node-pty-prebuilt-multiarch');
    process.exit(1);
  }

  try {
    const xterm = await import('@xterm/headless');
    // Handle ESM default export wrapping
    XtermTerminal = (xterm as any).Terminal || (xterm as any).default?.Terminal;
  } catch {
    console.error('@xterm/headless is required for PTY support.');
    console.error('Install: cd ' + '~/agents-cli && bun add @xterm/headless');
    process.exit(1);
  }

  const sessions = new Map<string, Session>();
  const socketPath = getSocketPath();
  const pidPath = getPtyPidPath();

  // Race resolution must happen BEFORE touching the socket file. Two clients
  // racing ensureServer() in pty-client.ts can both observe
  // isPtyServerRunning()=false and spawn parallel servers; without the
  // O_EXCL claim below, the second spawn would unlink the first's socket
  // inode and overwrite its PID file, orphaning the first server with its
  // kernel socket binding intact but unreachable via the filesystem.
  if (isPtyServerRunning()) {
    log('INFO', 'PTY server already running; duplicate spawn exits cleanly');
    process.exit(0);
  }
  try {
    fs.writeFileSync(pidPath, String(process.pid), { flag: 'wx', encoding: 'utf-8' });
  } catch (err: any) {
    if (err && err.code === 'EEXIST') {
      log('INFO', 'PID slot claimed by a concurrent server; exiting cleanly');
      process.exit(0);
    }
    throw err;
  }
  // We own the PID slot; ensure it's released on any exit path, not just SIGTERM/SIGINT.
  process.on('exit', () => { try { fs.unlinkSync(pidPath); } catch {} });

  // Remove stale socket from a prior crashed server. Safe now that we hold the PID
  // slot. Windows named pipes are not filesystem inodes — they vanish with their
  // owning process, so there's nothing to unlink (and existsSync always reports false).
  if (!IS_WINDOWS && fs.existsSync(socketPath)) {
    try { fs.unlinkSync(socketPath); } catch {}
  }

  let lastActivityTime = Date.now();

  function generateId(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  function killSession(session: Session): void {
    if (!session.exited) {
      try {
        session.pty.kill();
      } catch {}
      session.exited = true;
    }
    if (session.terminal) {
      try { session.terminal.dispose(); } catch {}
    }
  }

  function getScreenLines(session: Session): string[] {
    const lines: string[] = [];
    const buf = session.terminal.buffer.active;
    for (let y = 0; y < session.rows; y++) {
      const line = buf.getLine(y);
      const text = line ? line.translateToString(true) : '';
      // Strip lines containing the sentinel pattern
      if (text.includes(SENTINEL)) continue;
      lines.push(text);
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  // Session idle cleanup + server auto-exit
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_IDLE_MS) {
        log('INFO', `Cleaning up idle session ${id}`);
        killSession(session);
        sessions.delete(id);
      }
    }
    if (sessions.size === 0 && now - lastActivityTime > SERVER_IDLE_MS) {
      log('INFO', 'No sessions, server idle timeout reached. Shutting down.');
      shutdown();
    }
  }, 60_000);

  // --- Request handlers ---

  async function handleRequest(req: any): Promise<any> {
    lastActivityTime = Date.now();

    switch (req.action) {
      case 'start': {
        const rows = req.params?.rows || 24;
        const cols = req.params?.cols || 120;
        const shell = req.params?.shell
          || (IS_WINDOWS ? (process.env.ComSpec || 'powershell.exe') : (process.env.SHELL || 'zsh'));
        const cwd = req.params?.cwd
          || (IS_WINDOWS ? (process.env.USERPROFILE || process.env.HOME || process.cwd()) : (process.env.HOME || '/'));
        const id = generateId();

        let ptyProcess: any;
        try {
          ptyProcess = nodePty.spawn(shell, [], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: buildPtyEnv(),
          });
        } catch (err: any) {
          return { ok: false, error: `Failed to spawn PTY: ${err.message}` };
        }

        const terminal = new XtermTerminal({ rows, cols, allowProposedApi: true });

        const session: Session = {
          id,
          pty: ptyProcess,
          terminal,
          rows,
          cols,
          shell,
          cwd,
          pid: ptyProcess.pid,
          startTime: captureProcessStartTime(ptyProcess.pid),
          startedAt: Date.now(),
          lastActivity: Date.now(),
          pendingOutput: '',
          appActive: false,
          activeCommand: '',
          exited: false,
          exitCode: null,
        };

        ptyProcess.onData((data: string) => {
          session.pendingOutput += data;
          terminal.write(data);
          session.lastActivity = Date.now();

          // Check for sentinel to detect command completion
          if (session.appActive && session.pendingOutput.includes(SENTINEL + ':')) {
            session.appActive = false;
            session.activeCommand = '';
          }
        });

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          session.exited = true;
          session.exitCode = exitCode;
          session.appActive = false;
        });

        // Wait for shell to initialize, then clear init output
        await new Promise(r => setTimeout(r, 300));
        session.pendingOutput = '';

        sessions.set(id, session);
        log('INFO', `Session started: ${id} (pid=${ptyProcess.pid}, shell=${shell}, ${cols}x${rows})`);

        return { ok: true, id, pid: ptyProcess.pid, rows, cols, shell };
      }

      case 'exec': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };
        if (session.exited) return { ok: false, error: 'Session has exited' };
        if (session.appActive) {
          return { ok: false, error: `Command already active: ${session.activeCommand}. Use write to interact or signal to interrupt.` };
        }

        const command = req.params?.command;
        if (!command) return { ok: false, error: 'command is required' };

        session.appActive = true;
        session.activeCommand = command;
        session.pendingOutput = '';

        // Windows conpty submits on CR; POSIX line discipline expects LF.
        const submit = IS_WINDOWS ? '\r' : '\n';
        session.pty.write(`${buildSentinelCommand(session.shell, command)}${submit}`);
        session.lastActivity = Date.now();

        return { ok: true, submitted: true };
      }

      case 'read': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };

        const waitMs = Math.min(Math.max(req.params?.ms || 100, 50), 5000);

        // Wait for output to accumulate
        if (session.pendingOutput.length === 0) {
          await new Promise(r => setTimeout(r, waitMs));
        }

        const output = session.pendingOutput;
        session.pendingOutput = '';

        // Strip sentinel lines from output
        const cleaned = output
          .split('\n')
          .filter(line => !line.includes(SENTINEL))
          .join('\n');

        return {
          ok: true,
          output: cleaned,
          bytes: output.length,
          app_active: session.appActive,
          active_command: session.activeCommand || undefined,
          exited: session.exited,
          exit_code: session.exitCode,
        };
      }

      case 'write': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };
        if (session.exited) return { ok: false, error: 'Session has exited' };

        let input = req.params?.input ?? '';
        if (input === '') input = '\n';

        session.pty.write(input);
        session.lastActivity = Date.now();

        return { ok: true };
      }

      case 'screen': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };

        const lines = getScreenLines(session);
        const buf = session.terminal.buffer.active;

        return {
          ok: true,
          screen: lines.join('\n'),
          rows: session.rows,
          cols: session.cols,
          cursor: { x: buf.cursorX, y: buf.cursorY },
          app_active: session.appActive,
          active_command: session.activeCommand || undefined,
          exited: session.exited,
        };
      }

      case 'signal': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };
        if (session.exited) return { ok: false, error: 'Session has exited' };

        const sig = (req.params?.signal || 'INT').toUpperCase();
        if (!['INT', 'TERM', 'KILL', 'HUP'].includes(sig)) {
          return { ok: false, error: `Unsupported signal: ${sig}` };
        }

        // Guard against PID reuse: confirm the PID is still owned by the
        // process we spawned. If the start-time we captured at spawn no
        // longer matches /proc or `ps`, treat the session as exited and
        // refuse to signal — otherwise we'd kill an unrelated process that
        // happens to have inherited this PID.
        if (session.startTime !== null) {
          const current = captureProcessStartTime(session.pid);
          if (current === null || current !== session.startTime) {
            session.exited = true;
            return { ok: false, error: 'Session has exited' };
          }
        }

        try {
          // node-pty kill accepts signal number; use process.kill for named signals
          process.kill(session.pid, `SIG${sig}` as NodeJS.Signals);
        } catch (err: any) {
          return { ok: false, error: `Failed to send signal: ${err.message}` };
        }

        return { ok: true };
      }

      case 'resize': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };
        if (session.exited) return { ok: false, error: 'Session has exited' };

        const rows = req.params?.rows || session.rows;
        const cols = req.params?.cols || session.cols;

        session.pty.resize(cols, rows);
        session.terminal.resize(cols, rows);
        session.rows = rows;
        session.cols = cols;

        return { ok: true, rows, cols };
      }

      case 'list': {
        const list = [];
        for (const [, session] of sessions) {
          list.push({
            id: session.id,
            pid: session.pid,
            shell: session.shell,
            cwd: session.cwd,
            rows: session.rows,
            cols: session.cols,
            started_at: session.startedAt,
            last_activity: session.lastActivity,
            app_active: session.appActive,
            active_command: session.activeCommand || undefined,
            exited: session.exited,
            exit_code: session.exitCode,
          });
        }
        return { ok: true, sessions: list };
      }

      case 'stop': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };

        killSession(session);
        sessions.delete(req.id);
        log('INFO', `Session stopped: ${req.id}`);

        return { ok: true };
      }

      case 'ping': {
        return { ok: true, sessions: sessions.size, pid: process.pid };
      }

      default:
        return { ok: false, error: `Unknown action: ${req.action}` };
    }
  }

  // --- Socket server ---

  const server = net.createServer((conn) => {
    let buf = '';

    conn.on('data', async (chunk) => {
      buf += chunk.toString();
      const nlIndex = buf.indexOf('\n');
      if (nlIndex === -1) return;

      const line = buf.slice(0, nlIndex);
      buf = '';

      try {
        const req = JSON.parse(line);
        const res = await handleRequest(req);
        conn.write(JSON.stringify(res) + '\n');
      } catch (err: any) {
        conn.write(JSON.stringify({ ok: false, error: err.message || String(err) }) + '\n');
      }

      conn.end();
    });

    conn.on('error', () => {});
  });

  // Lock down the PTY scratch dir before opening the socket — without this,
  // any local user with execute on the parent dir could connect to the socket
  // during the listen()-to-chmod() window. macOS BSD AF_UNIX semantics make
  // socket mode advisory only, so the parent dir is the real boundary.
  //
  // On Windows the transport is a named pipe, not a filesystem inode: chmod/umask
  // are no-ops (and umask throws in some Node builds), and pipe ACLs default to
  // the creating user. So we skip the Unix hardening entirely there.
  const agentsDir = getPtyDirRoot();
  fs.mkdirSync(agentsDir, { recursive: true });
  if (!IS_WINDOWS) {
    fs.chmodSync(agentsDir, 0o700);

    // umask covers any inherited group/other bits while listen() is creating
    // the socket inode — it only matters for the unobservable instant before
    // we can chmod the inode itself.
    process.umask(0o077);
  }

  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => resolve());
  });

  // Surface chmod failures: a 0o600 socket is a load-bearing security
  // assumption, not a nice-to-have. If we can't lock it down, refuse to
  // start so the caller learns immediately. (No-op on Windows named pipes.)
  if (!IS_WINDOWS) {
    fs.chmodSync(socketPath, 0o600);
  }

  log('INFO', `PTY server started (PID: ${process.pid}, socket: ${socketPath})`);

  // Shutdown handler
  function shutdown(): void {
    log('INFO', 'PTY server shutting down');
    for (const session of sessions.values()) {
      killSession(session);
    }
    sessions.clear();
    clearInterval(cleanupInterval);
    server.close();
    // Named pipes are reclaimed by the OS on close; only Unix sockets leave a file.
    if (!IS_WINDOWS) { try { fs.unlinkSync(socketPath); } catch {} }
    try { fs.unlinkSync(getPtyPidPath()); } catch {}
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Keep alive
  await new Promise(() => {});
}
