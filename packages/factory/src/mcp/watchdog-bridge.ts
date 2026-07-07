import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as vscode from 'vscode';
import { getAllTerminals } from '../vscode/terminals.vscode';
import { resolvePeerMessage } from '../core/peerMessaging';
import { trimToLast } from '../core/watchdogLog';
import { runOnLeaderOnly } from '../monitor/gate';

const SOCKET_PATH = path.join(os.homedir(), '.agents', '.tmp', 'watchdog.sock');
const WATCHDOG_LOG = path.join(os.homedir(), '.agents', 'watchdog.log');
const PEER_MESSAGES_LOG = path.join(os.homedir(), '.agents', 'peer-messages.log');

// Hot path: append is O(1). Each log is trimmed back to LOG_MAX_LINES only
// once every LOG_TRIM_EVERY appends, not on every write, so high-frequency
// nudges/peer-messages don't read+rewrite the whole file each time.
const LOG_MAX_LINES = 500;
const LOG_TRIM_EVERY = 100;
const appendCounts = new Map<string, number>();

async function appendLineTrimmed(logPath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, line, 'utf8');
  const n = (appendCounts.get(logPath) ?? 0) + 1;
  appendCounts.set(logPath, n);
  if (n % LOG_TRIM_EVERY === 0) {
    try {
      const existing = await fs.readFile(logPath, 'utf8');
      const trimmed = trimToLast(existing, LOG_MAX_LINES);
      if (trimmed.length !== existing.length) {
        await fs.writeFile(logPath, trimmed, 'utf8');
      }
    } catch {
      // file missing or unreadable — nothing to trim
    }
  }
}

export interface WatchdogBridge {
  mcpServerPath: string;
  dispose(): void;
}

interface SendNudgeRequest {
  sessionId: string;
  text: string;
  reason: string;
}

interface SendNudgeResponse {
  success: boolean;
  error?: string;
  nudgedAt?: number;
  terminalId?: string;
}

interface SendToAgentRequest {
  kind: 'peer';
  senderSessionId: string;
  targetSessionId: string;
  text: string;
}

interface SendToAgentResponse {
  success: boolean;
  error?: string;
  sentAt?: number;
  recipientTerminalId?: string;
}

type ExtensionRequest = SendNudgeRequest | SendToAgentRequest;

function isPeerRequest(req: ExtensionRequest): req is SendToAgentRequest {
  return (req as SendToAgentRequest).kind === 'peer';
}

async function ensureSocketDir(): Promise<void> {
  const dir = path.dirname(SOCKET_PATH);
  await fs.mkdir(dir, { recursive: true });
}

async function cleanupSocket(): Promise<void> {
  try {
    await fs.unlink(SOCKET_PATH);
  } catch {
    // Socket doesn't exist, that's fine
  }
}

async function logNudge(entry: {
  sessionId: string;
  terminalId: string;
  agentType: string | undefined;
  text: string;
  reason: string;
}): Promise<void> {
  const logEntry = {
    ts: Date.now(),
    ...entry,
  };
  try {
    await appendLineTrimmed(WATCHDOG_LOG, JSON.stringify(logEntry) + '\n');
  } catch (err) {
    console.warn('[WATCHDOG] Failed to log nudge:', err);
  }
}

async function logPeerMessage(entry: {
  senderSessionId: string;
  targetSessionId: string;
  recipientTerminalId: string;
  recipientAgentType: string | undefined;
  text: string;
}): Promise<void> {
  const logEntry = {
    ts: Date.now(),
    ...entry,
  };
  try {
    await appendLineTrimmed(PEER_MESSAGES_LOG, JSON.stringify(logEntry) + '\n');
  } catch (err) {
    console.warn('[PEER-MSG] Failed to log message:', err);
  }
}

async function handleSendToAgent(
  request: SendToAgentRequest
): Promise<SendToAgentResponse> {
  const { senderSessionId, targetSessionId, text } = request;

  const resolved = resolvePeerMessage({
    terminals: getAllTerminals(),
    senderSessionId,
    targetSessionId,
    text,
  });

  if (resolved.kind !== 'ok') {
    return { success: false, error: resolved.error };
  }

  const { terminal: recipient, trimmedText } = resolved;
  // resolvePeerMessage returns the lookup record (id, sessionId, agentType).
  // Re-locate the live vscode.Terminal handle by id so the bridge keeps the
  // type information without leaking it across the module boundary.
  const live = getAllTerminals().find((t) => t.id === recipient.id);
  if (!live) {
    return { success: false, error: `Terminal ${recipient.id} disappeared` };
  }

  try {
    // Claude's Ink TUI needs an explicit carriage return; other agents take \n.
    if (live.agentType === 'claude') {
      live.terminal.sendText(trimmedText, false);
      live.terminal.sendText('\r', false);
    } else {
      live.terminal.sendText(trimmedText, true);
    }

    await logPeerMessage({
      senderSessionId: senderSessionId || 'unknown',
      targetSessionId,
      recipientTerminalId: live.id,
      recipientAgentType: live.agentType,
      text: trimmedText,
    });

    console.log(
      `[PEER-MSG] ${senderSessionId || 'unknown'} -> ${live.id} (${live.agentType}): "${trimmedText.slice(0, 80)}${trimmedText.length > 80 ? '…' : ''}"`
    );

    return {
      success: true,
      sentAt: Date.now(),
      recipientTerminalId: live.id,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to send text: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function handleSendNudge(
  request: SendNudgeRequest
): Promise<SendNudgeResponse> {
  const { sessionId, text, reason } = request;

  // Find terminal by sessionId
  const terminals = getAllTerminals();
  const entry = terminals.find((t) => t.sessionId === sessionId);

  if (!entry) {
    // Try partial match (sessionId might be truncated)
    const partialMatch = terminals.find((t) =>
      t.sessionId?.startsWith(sessionId) || sessionId.startsWith(t.sessionId || '')
    );
    if (!partialMatch) {
      return {
        success: false,
        error: `No terminal found for session ${sessionId}. Active sessions: ${terminals.map((t) => t.sessionId).filter(Boolean).join(', ')}`,
      };
    }
  }

  const terminal = entry || terminals.find((t) =>
    t.sessionId?.startsWith(sessionId) || sessionId.startsWith(t.sessionId || '')
  );

  if (!terminal) {
    return { success: false, error: 'Terminal lookup failed' };
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    return { success: false, error: 'Text cannot be empty' };
  }

  if (trimmedText.length > 200) {
    return { success: false, error: 'Text must be under 200 characters' };
  }

  try {
    // Use \r for Claude's Ink TUI, \n for others
    if (terminal.agentType === 'claude') {
      terminal.terminal.sendText(trimmedText, false);
      terminal.terminal.sendText('\r', false);
    } else {
      terminal.terminal.sendText(trimmedText, true);
    }

    await logNudge({
      sessionId,
      terminalId: terminal.id,
      agentType: terminal.agentType,
      text: trimmedText,
      reason,
    });

    console.log(
      `[WATCHDOG] Nudged ${terminal.id} (${terminal.agentType}): "${trimmedText}" — ${reason}`
    );

    return {
      success: true,
      nudgedAt: Date.now(),
      terminalId: terminal.id,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to send text: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// In-process nudge entry for the extension host itself (Dispatch's
// `nudgeAgent` action + the 'keep' watchdog policy's auto-nudge/escalate).
// Reuses the exact terminal-lookup + Ink-vs-newline delivery that the MCP
// socket path uses, so a UI-driven nudge and an agent-driven nudge behave
// identically. `reason` is recorded to the watchdog log for audit.
export async function nudgeSession(
  sessionId: string,
  text: string,
  reason: string,
): Promise<SendNudgeResponse> {
  return handleSendNudge({ sessionId, text, reason });
}

export function startWatchdogBridge(
  context: vscode.ExtensionContext
): WatchdogBridge {
  const mcpServerPath = path.join(
    context.extensionPath,
    'dist',
    'mcp',
    'watchdog-server.js'
  );

  let server: net.Server | null = null;

  const startServer = async () => {
    await ensureSocketDir();
    await cleanupSocket();

    server = net.createServer((socket) => {
      let data = '';

      socket.on('data', (chunk) => {
        data += chunk.toString();
      });

      socket.on('end', async () => {
        try {
          const request = JSON.parse(data) as ExtensionRequest;
          const result = isPeerRequest(request)
            ? await handleSendToAgent(request)
            : await handleSendNudge(request);
          socket.write(JSON.stringify(result));
        } catch (err) {
          socket.write(
            JSON.stringify({
              success: false,
              error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
            })
          );
        }
        socket.end();
      });

      socket.on('error', (err) => {
        console.error('[WATCHDOG] Socket error:', err);
      });
    });

    server.listen(SOCKET_PATH, () => {
      console.log(`[WATCHDOG] Bridge listening on ${SOCKET_PATH}`);
    });

    server.on('error', (err) => {
      console.error('[WATCHDOG] Server error:', err);
    });
  };

  const stopServer = () => {
    if (server) {
      server.close();
      server = null;
    }
    cleanupSocket().catch(() => {});
  };

  // Only the elected monitor leader binds the shared socket (#70). Every window
  // used to start its own bridge and unconditionally unlink+relisten on the same
  // path, so the last window to activate clobbered the others. Gating ownership
  // behind the leader makes it deterministic: the leader owns the socket, and on
  // a leadership flip the new leader binds while the old one releases. The MCP
  // server path is static, so followers still return it for `--mcp` wiring.
  const gate = runOnLeaderOnly(() => {
    startServer().catch((err) => {
      console.error('[WATCHDOG] Failed to start bridge:', err);
    });
    return { dispose: stopServer };
  });

  return {
    mcpServerPath,
    dispose() {
      gate.dispose();
      console.log('[WATCHDOG] Bridge disposed');
    },
  };
}
