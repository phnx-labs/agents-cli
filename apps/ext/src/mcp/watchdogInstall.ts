import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type Agent = 'claude' | 'gemini';

const SERVER_NAME = 'watchdog';

async function isCliAvailable(agent: Agent): Promise<boolean> {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execAsync(`${which} ${agent}`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function isInstalled(agent: Agent): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`${agent} mcp list`, { timeout: 5000 });
    return new RegExp(`\\b${SERVER_NAME}\\b`, 'i').test(stdout);
  } catch {
    return false;
  }
}

async function install(agent: Agent, mcpServerPath: string): Promise<void> {
  // Claude: `claude mcp add --scope user <name> <command> [args...]`
  // Gemini: `gemini mcp add <name> <commandOrUrl> [args...]`
  const cmd =
    agent === 'claude'
      ? `claude mcp add --scope user ${SERVER_NAME} node "${mcpServerPath}"`
      : `gemini mcp add ${SERVER_NAME} node "${mcpServerPath}"`;
  await execAsync(cmd, { timeout: 10000 });
}

// Memoize per extension load: this runs on every activation, but the four
// `which`/`mcp list` subprocesses only need to run once per process. Repeat
// callers get the in-flight/completed promise instead of re-forking.
let installPromise: Promise<void> | null = null;

async function ensureOne(agent: Agent, mcpServerPath: string): Promise<void> {
  if (!(await isCliAvailable(agent))) {
    return;
  }
  try {
    if (await isInstalled(agent)) {
      return;
    }
    await install(agent, mcpServerPath);
    console.log(`[WATCHDOG] Registered ${SERVER_NAME} MCP for ${agent}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[WATCHDOG] Failed to register MCP for ${agent}: ${message}`);
  }
}

/**
 * Register the watchdog MCP server in each supported agent's user-scope
 * config so peer terminals can call `send_to_agent`. Idempotent — skips
 * agents whose CLI is missing or that already have a `watchdog` entry.
 *
 * Agents are probed in parallel (no longer four sequential subprocesses on the
 * activation path) and the result is memoized for the process lifetime.
 */
export function ensureWatchdogMcpInstalled(mcpServerPath: string): Promise<void> {
  if (installPromise) return installPromise;
  const agents: Agent[] = ['claude', 'gemini'];
  installPromise = Promise.all(
    agents.map((agent) => ensureOne(agent, mcpServerPath)),
  ).then(() => undefined);
  return installPromise;
}

/** Test-only: drop the memoized result so the next call re-probes. */
export function __resetWatchdogInstallCache(): void {
  installPromise = null;
}
