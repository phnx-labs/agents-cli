// Simple command-based session pre-warming for Codex and Gemini
// Claude doesn't need prewarming - just generate UUID at terminal open time

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import {
  PrewarmAgentType,
  PrewarmResult,
  stripAnsi,
} from './prewarm';

// Configuration for simple command-based prewarm
interface SimplePrewarmConfig {
  // Method: 'none' for Claude (no prewarm), 'spawn-kill' kills after getting session ID
  method: 'none' | 'spawn-kill' | 'spawn-wait';
  // Command args for spawn
  command: string[];
  // Extract session ID from output (streaming for spawn-kill)
  extractSessionId?: (output: string) => string | null;
  timeout: number;
}

const SIMPLE_PREWARM_CONFIGS: Record<PrewarmAgentType, SimplePrewarmConfig> = {
  claude: {
    // Claude doesn't need prewarming - we generate UUID at terminal open time
    // and pass it via `claude --session-id <uuid>`
    method: 'none',
    command: [],
    timeout: 0,
  },
  gemini: {
    // Spawn gemini, wait for the command to finish so session is persisted
    method: 'spawn-wait',
    command: ['gemini', '-p', ' ', '-o', 'json'],
    extractSessionId: (output: string): string | null => {
      // Look for "session_id": "<uuid>" in streaming output
      const match = output.match(/"session_id":\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
      return match ? match[1] : null;
    },
    timeout: 30000,
  },
  codex: {
    // Spawn codex, kill as soon as we see session id in banner
    method: 'spawn-kill',
    command: ['codex', 'exec', ''],
    extractSessionId: (output: string): string | null => {
      const clean = stripAnsi(output);
      // Pattern: "session id: 019ba3f0-4dda-79b0-a8cc-6832bf78d6a9"
      const match = clean.match(/session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return match ? match[1] : null;
    },
    timeout: 20000,
  },
  cursor: {
    // Spawn cursor-agent with a simple prompt, wait for JSON response
    method: 'spawn-wait',
    command: ['cursor-agent', '-p', 'Hello! Be right back.', '--output-format', 'json'],
    extractSessionId: (output: string): string | null => {
      // Parse JSON output for session_id
      // Output: {"type":"result",...,"session_id":"874384ec-7236-4887-aa1c-f627754ce0c0",...}
      try {
        const parsed = JSON.parse(output.trim());
        return parsed.session_id || null;
      } catch {
        return null;
      }
    },
    timeout: 30000,
  },
  opencode: {
    // OpenCode doesn't need prewarming - session ID is detected from session list
    // after the terminal starts
    method: 'none',
    command: [],
    timeout: 0,
  },
};

/**
 * Check if agent type needs actual prewarming (spawning a process)
 * Claude doesn't need it - we just generate UUID at open time
 */
export function needsPrewarming(agentType: PrewarmAgentType): boolean {
  return agentType === 'codex' || agentType === 'gemini' || agentType === 'cursor';
}

/**
 * Generate a session ID for Claude (no prewarming needed)
 */
export function generateClaudeSessionId(): string {
  return randomUUID();
}

/**
 * Build the open command for Claude with a session ID
 */
export function buildClaudeOpenCommand(sessionId: string): string {
  return `claude --session-id ${sessionId}`;
}

/**
 * Spawn a prewarm session using simple command execution
 * - Claude: Returns immediately with generated UUID (no command execution)
 * - Codex: Spawn 'codex exec', kill as soon as session id appears in banner
 * - Gemini: Spawn with -o json, kill as soon as session_id appears in JSON
 */
export async function spawnSimplePrewarmSession(
  agentType: PrewarmAgentType,
  cwd: string
): Promise<PrewarmResult> {
  const config = SIMPLE_PREWARM_CONFIGS[agentType];
  if (!config) {
    return {
      status: 'failed',
      failedReason: 'cli_not_found',
      rawOutput: `Simple prewarm not available for ${agentType}`,
    };
  }

  // Claude: No prewarming needed, generate UUID immediately
  if (config.method === 'none') {
    if (agentType === 'claude') {
      const sessionId = generateClaudeSessionId();
      console.log(`[PREWARM] Claude using on-demand session ID: ${sessionId}`);
      return {
        status: 'success',
        sessionId,
        rawOutput: 'No prewarming needed for Claude',
      };
    }
    return {
      status: 'failed',
      failedReason: 'parse_error',
      rawOutput: `No prewarming flow for ${agentType}`,
    };
  }

  // Codex/Gemini: spawn-kill method
  if (config.method === 'spawn-wait') {
    return spawnWaitMethod(agentType, cwd, config);
  }

  return spawnKillMethod(agentType, cwd, config);
}

/**
 * Spawn-kill method: Start process, watch output, kill as soon as session ID found
 * Prevents the CLI from doing any actual work (like reading files)
 */
function spawnKillMethod(
  agentType: PrewarmAgentType,
  cwd: string,
  config: SimplePrewarmConfig
): Promise<PrewarmResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = config.command;
    let output = '';
    let resolved = false;
    let sessionId: string | null = null;

    console.log(`[PREWARM] Simple spawn-kill for ${agentType}: ${cmd} ${args.join(' ')}`);

    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately so processes waiting for input (e.g. codex)
    // receive EOF and exit rather than hanging until the timeout fires.
    proc.stdin?.end();

    const finish = (result: PrewarmResult) => {
      if (resolved) return;
      resolved = true;

      // Kill the process if still running
      if (!proc.killed) {
        proc.kill('SIGTERM');
        // Force kill after 500ms if still alive
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 500);
      }

      resolve(result);
    };

    const checkOutput = () => {
      if (resolved) return;

      // Try to extract session ID
      sessionId = config.extractSessionId?.(output) || null;
      if (sessionId) {
        console.log(`[PREWARM] ${agentType} spawn-kill got session ID: ${sessionId}, killing process`);
        finish({
          status: 'success',
          sessionId,
          rawOutput: output,
        });
      }
    };

    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
      checkOutput();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
      checkOutput();
    });

    proc.on('error', (err: Error) => {
      console.log(`[PREWARM] ${agentType} spawn error: ${err.message}`);
      finish({
        status: 'failed',
        failedReason: 'cli_error',
        rawOutput: output + `\nError: ${err.message}`,
      });
    });

    proc.on('close', (code: number | null) => {
      console.log(`[PREWARM] ${agentType} spawn closed with code ${code}, output: ${output.length} bytes`);
      if (!resolved) {
        // Process exited before we found session ID
        if (sessionId) {
          finish({ status: 'success', sessionId, rawOutput: output });
        } else {
          console.log(`[PREWARM] ${agentType} spawn-kill parse_error - output: ${output.slice(0, 500)}`);
          finish({ status: 'failed', failedReason: 'parse_error', rawOutput: output });
        }
      }
    });

    // Timeout
    setTimeout(() => {
      if (!resolved) {
        console.log(`[PREWARM] ${agentType} spawn-kill timeout`);
        finish({ status: 'failed', failedReason: 'timeout', rawOutput: output });
      }
    }, config.timeout);
  });
}

/**
 * Spawn-wait method: Start process, collect output, wait for exit
 * Used for Gemini to allow the session to be persisted before exiting.
 */
async function spawnWaitMethod(
  agentType: PrewarmAgentType,
  cwd: string,
  config: SimplePrewarmConfig
): Promise<PrewarmResult> {
  const [cmd, ...args] = config.command;
  let output = '';
  let resolved = false;
  let sessionId: string | null = null;

  console.log(`[PREWARM] Simple spawn-wait for ${agentType}: ${cmd} ${args.join(' ')}`);

  const sessionsBefore = agentType === 'gemini' ? await listGeminiSessions(cwd) : null;

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = async (result: PrewarmResult) => {
      if (resolved) return;
      resolved = true;

      if (result.status === 'success' && agentType === 'gemini') {
        const resolvedId = await resolveGeminiSessionId(cwd, sessionsBefore, sessionId);
        if (resolvedId) {
          result.sessionId = resolvedId;
        }
      }

      resolve(result);
    };

    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
      sessionId = config.extractSessionId?.(output) || sessionId;
    });

    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
      sessionId = config.extractSessionId?.(output) || sessionId;
    });

    proc.on('error', (err: Error) => {
      console.log(`[PREWARM] ${agentType} spawn error: ${err.message}`);
      finish({
        status: 'failed',
        failedReason: 'cli_error',
        rawOutput: output + `\nError: ${err.message}`,
      });
    });

    proc.on('close', (code: number | null) => {
      console.log(`[PREWARM] ${agentType} spawn closed with code ${code}, output: ${output.length} bytes`);
      if (sessionId) {
        finish({ status: 'success', sessionId, rawOutput: output });
      } else {
        finish({ status: 'failed', failedReason: 'parse_error', rawOutput: output });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        console.log(`[PREWARM] ${agentType} spawn-wait timeout`);
        if (!proc.killed) {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 500);
        }
        finish({ status: 'failed', failedReason: 'timeout', rawOutput: output });
      }
    }, config.timeout);
  });
}

/**
 * Get OpenCode session IDs from 'opencode session list' output
 * Returns most recent sessions first (sorted by updated time)
 */
export async function listOpencodeSessions(cwd: string): Promise<string[] | null> {
  const result = await runCommand('opencode', ['session', 'list'], cwd, 10000);
  if (!result) return null;
  // Parse session IDs from table output: ses_xxx format
  const matches = [...result.matchAll(/ses_[a-zA-Z0-9]+/g)];
  if (matches.length === 0) return [];
  return matches.map(m => m[0]);
}

/**
 * Get Gemini session IDs from --list-sessions output
 */
async function listGeminiSessions(cwd: string): Promise<string[] | null> {
  const [cmd, ...args] = ['gemini', '--list-sessions'];
  const result = await runCommand(cmd, args, cwd, 10000);
  if (!result) return null;
  const matches = [...result.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi)];
  if (matches.length === 0) return [];
  return matches.map(m => m[1]);
}

async function resolveGeminiSessionId(
  cwd: string,
  sessionsBefore: string[] | null,
  outputSessionId: string | null
): Promise<string | null> {
  const sessionsAfter = await listGeminiSessions(cwd);
  if (!sessionsAfter || sessionsAfter.length === 0) {
    return outputSessionId;
  }

  if (outputSessionId && sessionsAfter.includes(outputSessionId)) {
    return outputSessionId;
  }

  if (sessionsBefore && sessionsBefore.length > 0) {
    const beforeSet = new Set(sessionsBefore);
    const added = sessionsAfter.filter(id => !beforeSet.has(id));
    if (added.length === 1) return added[0];
    if (added.length > 1) return added[added.length - 1];
  }

  return outputSessionId ?? sessionsAfter[sessionsAfter.length - 1] ?? null;
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    let output = '';
    let resolved = false;

    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('error', () => {
      finish(null);
    });

    proc.on('close', () => {
      finish(output);
    });

    setTimeout(() => {
      if (!resolved) {
        if (!proc.killed) {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 500);
        }
        finish(null);
      }
    }, timeoutMs);
  });
}
