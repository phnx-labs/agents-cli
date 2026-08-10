// Session pre-warming - VS Code integration
// Claude: No prewarming needed, generate UUID at open time
// Codex/Gemini: Spawn process, extract session ID, kill immediately

import * as vscode from 'vscode';
import {
  PrewarmAgentType,
  PrewarmedSession,
  SessionPoolState,
  TerminalSessionMapping,
  PREWARM_CONFIGS,
  DEFAULT_POOL_SIZE,
  needsReplenishment,
  selectBestSession,
  getSupportedAgentTypes
} from '../core/prewarm';
import {
  spawnSimplePrewarmSession,
  needsPrewarming,
  generateClaudeSessionId,
} from '../core/prewarm.simple';

// GlobalState keys
const POOL_KEY_PREFIX = 'prewarm.pool.';
const MAPPINGS_KEY = 'prewarm.mappings';
const ENABLED_KEY = 'prewarm.enabled';
const CLEAN_SHUTDOWN_KEY = 'prewarm.cleanShutdown';

// In-memory state
const pools: Map<PrewarmAgentType, SessionPoolState> = new Map();
let isInitialized = false;

/**
 * Check if pre-warming is enabled
 */
export function isEnabled(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(ENABLED_KEY, true);
}

/**
 * Enable or disable pre-warming
 */
export async function setEnabled(context: vscode.ExtensionContext, enabled: boolean): Promise<void> {
  await context.globalState.update(ENABLED_KEY, enabled);
  console.log(`[PREWARM] Pre-warming ${enabled ? 'enabled' : 'disabled'}`);

  if (enabled && !isInitialized) {
    await initializePrewarming(context);
  }
}

/**
 * Get pool state for an agent type
 */
function getPool(agentType: PrewarmAgentType): SessionPoolState {
  if (!pools.has(agentType)) {
    pools.set(agentType, { available: [], pending: 0 });
  }
  return pools.get(agentType)!;
}

/**
 * Save pool to globalState
 */
async function persistPool(context: vscode.ExtensionContext, agentType: PrewarmAgentType): Promise<void> {
  const pool = getPool(agentType);
  await context.globalState.update(`${POOL_KEY_PREFIX}${agentType}`, pool.available);
}

/**
 * Load pool from globalState
 */
function loadPool(context: vscode.ExtensionContext, agentType: PrewarmAgentType): void {
  const saved = context.globalState.get<PrewarmedSession[]>(`${POOL_KEY_PREFIX}${agentType}`, []);
  const pool = getPool(agentType);
  pool.available = saved;
  console.log(`[PREWARM] Loaded ${saved.length} ${agentType} sessions from storage`);
}

/**
 * Pre-warm a single session
 * Claude: Returns immediately with generated UUID (no actual prewarming)
 * Codex/Gemini: Spawns process, extracts session ID, kills immediately
 */
async function prewarmSession(
  context: vscode.ExtensionContext,
  agentType: PrewarmAgentType
): Promise<PrewarmedSession | null> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const pool = getPool(agentType);

  pool.pending++;
  console.log(`[PREWARM] Starting ${agentType} session (pending: ${pool.pending})`);

  try {
    const result = await spawnSimplePrewarmSession(agentType, cwd);

    if (result.status === 'success' && result.sessionId) {
      console.log(`[PREWARM] ${agentType} session created: ${result.sessionId}`);
      return {
        agentType,
        sessionId: result.sessionId,
        createdAt: Date.now(),
        workingDirectory: cwd,
      };
    }

    if (result.status === 'blocked') {
      console.warn(`[PREWARM] ${agentType} blocked: ${result.blockedReason}`);
      // Show notification for blocking prompts
      if (result.blockedReason === 'trust_prompt') {
        vscode.window.showWarningMessage(
          `Session warming blocked: ${agentType} requires folder trust. Trust this directory in ${agentType} settings to enable warming.`
        );
      } else if (result.blockedReason === 'auth_required') {
        vscode.window.showWarningMessage(
          `Session warming blocked: ${agentType} requires authentication. Please log in to enable warming.`
        );
      }
    } else if (result.status === 'failed') {
      console.warn(`[PREWARM] ${agentType} failed: ${result.failedReason}`);
    }

    return null;
  } finally {
    pool.pending--;
  }
}

/**
 * Replenish pool for an agent type
 */
async function replenishPool(
  context: vscode.ExtensionContext,
  agentType: PrewarmAgentType,
  targetSize: number = DEFAULT_POOL_SIZE
): Promise<void> {
  const pool = getPool(agentType);
  const needed = needsReplenishment(pool, targetSize);

  if (needed === 0) {
    console.log(`[PREWARM] ${agentType} pool is full (${pool.available.length} available)`);
    return;
  }

  console.log(`[PREWARM] Replenishing ${agentType} pool: need ${needed} sessions`);

  // Spawn sessions in parallel
  const promises = Array(needed).fill(null).map(() => prewarmSession(context, agentType));
  const results = await Promise.all(promises);

  // Add successful sessions to pool
  for (const session of results) {
    if (session) {
      pool.available.push(session);
    }
  }

  await persistPool(context, agentType);
  console.log(`[PREWARM] ${agentType} pool now has ${pool.available.length} available sessions`);
}

/**
 * Initialize pre-warming on extension activation
 */
export async function initializePrewarming(context: vscode.ExtensionContext): Promise<void> {
  if (!isEnabled(context)) {
    console.log('[PREWARM] Pre-warming is disabled');
    return;
  }

  console.log('[PREWARM] Initializing pre-warming...');
  isInitialized = true;

  // Load existing pools from storage
  for (const agentType of getSupportedAgentTypes()) {
    loadPool(context, agentType);
  }

  // Clear clean shutdown flag (we're starting fresh)
  await context.globalState.update(CLEAN_SHUTDOWN_KEY, false);

  // Replenish pools in background
  for (const agentType of getSupportedAgentTypes()) {
    // Don't await - run in background
    replenishPool(context, agentType).catch(err => {
      console.error(`[PREWARM] Failed to replenish ${agentType} pool:`, err);
    });
  }
}

/**
 * Acquire a pre-warmed session for use
 */
export function acquireSession(
  context: vscode.ExtensionContext,
  agentType: PrewarmAgentType,
  cwd: string
): PrewarmedSession | null {
  if (!isEnabled(context)) return null;

  const pool = getPool(agentType);
  const session = selectBestSession(pool.available, cwd);

  if (session) {
    // Remove from pool
    const idx = pool.available.indexOf(session);
    if (idx !== -1) {
      pool.available.splice(idx, 1);
    }
    persistPool(context, agentType);
    console.log(`[PREWARM] Acquired ${agentType} session: ${session.sessionId}`);

    // Trigger replenishment in background
    scheduleReplenishment(context, agentType);
  }

  return session;
}

/**
 * Schedule pool replenishment (debounced)
 */
const replenishTimeouts: Map<PrewarmAgentType, NodeJS.Timeout> = new Map();

export function scheduleReplenishment(
  context: vscode.ExtensionContext,
  agentType: PrewarmAgentType
): void {
  // Cancel existing timeout
  const existing = replenishTimeouts.get(agentType);
  if (existing) {
    clearTimeout(existing);
  }

  // Schedule replenishment after 1 second
  const timeout = setTimeout(() => {
    replenishPool(context, agentType).catch(err => {
      console.error(`[PREWARM] Replenishment failed for ${agentType}:`, err);
    });
  }, 1000);

  replenishTimeouts.set(agentType, timeout);
}

// === Terminal-to-Session Mapping for Crash Recovery ===

/**
 * Get all terminal-session mappings
 */
export function getMappings(context: vscode.ExtensionContext): TerminalSessionMapping[] {
  return context.globalState.get<TerminalSessionMapping[]>(MAPPINGS_KEY, []);
}

/**
 * Save terminal-session mapping
 */
export async function recordTerminalSession(
  context: vscode.ExtensionContext,
  terminalId: string,
  sessionId: string,
  agentType: PrewarmAgentType,
  cwd: string
): Promise<void> {
  const mappings = getMappings(context);

  // Remove existing mapping for this terminal if any
  const existing = mappings.findIndex(m => m.terminalId === terminalId);
  if (existing !== -1) {
    mappings.splice(existing, 1);
  }

  mappings.push({
    terminalId,
    sessionId,
    agentType,
    createdAt: Date.now(),
    workingDirectory: cwd
  });

  await context.globalState.update(MAPPINGS_KEY, mappings);
  console.log(`[PREWARM] Recorded mapping: ${terminalId} -> ${sessionId}`);
}

/**
 * Remove terminal-session mapping
 */
export async function removeTerminalSession(
  context: vscode.ExtensionContext,
  terminalId: string
): Promise<void> {
  const mappings = getMappings(context);
  const idx = mappings.findIndex(m => m.terminalId === terminalId);

  if (idx !== -1) {
    const removed = mappings.splice(idx, 1)[0];
    await context.globalState.update(MAPPINGS_KEY, mappings);
    console.log(`[PREWARM] Removed mapping: ${terminalId} -> ${removed.sessionId}`);
  }
}

/**
 * Mark clean shutdown (called in deactivate)
 */
export async function markCleanShutdown(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(CLEAN_SHUTDOWN_KEY, true);
  console.log('[PREWARM] Marked clean shutdown');
}

/**
 * Check if last shutdown was clean
 */
export function wasCleanShutdown(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(CLEAN_SHUTDOWN_KEY, true);
}

/**
 * Restore terminals from previous crash
 * Returns number of terminals restored
 */
export async function restoreTerminals(context: vscode.ExtensionContext): Promise<number> {
  if (wasCleanShutdown(context)) {
    // Clean shutdown - clear mappings, don't restore
    await context.globalState.update(MAPPINGS_KEY, []);
    return 0;
  }

  const mappings = getMappings(context);
  if (mappings.length === 0) return 0;

  console.log(`[PREWARM] Detected crash - ${mappings.length} terminals to restore`);

  // TODO: Implement terminal restoration
  // For now, just clear the mappings and let user know
  const action = await vscode.window.showInformationMessage(
    `Found ${mappings.length} agent session(s) from previous crash. Restore them?`,
    'Restore',
    'Dismiss'
  );

  if (action === 'Restore') {
    // Return count, actual restoration handled elsewhere
    return mappings.length;
  }

  // Clear mappings if dismissed
  await context.globalState.update(MAPPINGS_KEY, []);
  return 0;
}

// === Webview Data ===

export interface PrewarmPoolInfo {
  agentType: PrewarmAgentType;
  available: number;
  pending: number;
  sessions: Array<{
    sessionId: string;
    createdAt: number;
    workingDirectory: string;
  }>;
}

/**
 * Get pool info for webview display
 */
export function getPoolInfo(): PrewarmPoolInfo[] {
  return getSupportedAgentTypes().map(agentType => {
    const pool = getPool(agentType);
    return {
      agentType,
      available: pool.available.length,
      pending: pool.pending,
      sessions: pool.available.map(s => ({
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        workingDirectory: s.workingDirectory
      }))
    };
  });
}

/**
 * Check if CLI is available for an agent type
 */
export async function isCliAvailable(agentType: PrewarmAgentType): Promise<boolean> {
  const { spawn } = require('child_process');
  const config = PREWARM_CONFIGS[agentType];
  const command = config.command; // Use config.command (e.g., 'cursor-agent' for cursor)

  return new Promise((resolve) => {
    const proc = spawn(command, ['--version'], { shell: true });
    let resolved = false;
    const finish = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    proc.on('close', (code: number) => finish(code === 0));
    proc.on('error', () => finish(false));
    setTimeout(() => {
      proc.kill();
      finish(false);
    }, 5000);
  });
}

// Re-export helpers from prewarm.simple for use in extension.ts
export { needsPrewarming, generateClaudeSessionId, buildClaudeOpenCommand } from '../core/prewarm.simple';
