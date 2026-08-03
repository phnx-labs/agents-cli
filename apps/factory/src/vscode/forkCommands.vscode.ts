import { buildForkSessionRequest, type ForkSessionSource } from '../core/forkSession';
import type { RunStrategy } from '../core/agents';

export interface ForkPickHostLaunch<ViewColumn> {
  prompt: string;
  strategy?: RunStrategy;
  host?: string;
  local: boolean;
  viewColumn: ViewColumn;
}

export interface ForkPickHostRecord {
  sourceSessionId: string;
  sourceHost: string;
  forkSessionId: string | null;
  forkHost: string;
  agentKey: string;
  forkedAt: number;
  terminalId: string;
}

export function sessionIdForTerminal(activeJson: string, terminalId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(activeJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const match = parsed.find((row): row is { terminalId: string; sessionId: string } =>
    !!row && typeof row === 'object' &&
    (row as { terminalId?: unknown }).terminalId === terminalId &&
    typeof (row as { sessionId?: unknown }).sessionId === 'string');
  return match?.sessionId.trim() || null;
}

export async function remoteForkSessionId(
  run: (args: string, options: { maxBuffer: number; timeout: number }) => Promise<{ stdout: string }>,
  host: string,
  terminalId: string,
  quote: (value: string) => string,
): Promise<string | null> {
  const { stdout } = await run(`sessions --active --json --host ${quote(host)}`, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 45_000,
  });
  return sessionIdForTerminal(stdout, terminalId);
}

/** Wait for a just-launched sibling to publish its session id. Local forks use
 * the extension terminal registry; offloaded forks use that host's active feed,
 * joined by the AGENT_TERMINAL_ID assigned before launch. */
export async function resolveForkSessionId(opts: {
  initialSessionId: string | null;
  terminalId: string;
  forkHost: string;
  localHost: string;
  attempts: number;
  wait: () => Promise<void>;
  readLocal: (terminalId: string) => string | null;
  readRemote: (host: string, terminalId: string) => Promise<string | null>;
}): Promise<string | null> {
  if (opts.initialSessionId) return opts.initialSessionId;
  const remote = opts.forkHost.trim().toLowerCase() !== opts.localHost.trim().toLowerCase();
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    await opts.wait();
    const sessionId = remote
      ? await opts.readRemote(opts.forkHost, opts.terminalId)
      : opts.readLocal(opts.terminalId);
    if (sessionId) return sessionId;
  }
  return null;
}

/** Keep the VS Code command id coupled to its executable handler. */
export function registerForkPickHostCommand<Disposable>(
  register: (command: string, callback: () => Promise<void>) => Disposable,
  run: () => Promise<void>,
): Disposable {
  return register('agents.forkPickHost', run);
}

/**
 * The executable `Agents: Fork (Pick Host)` path. The extension supplies VS Code
 * effects; this seam keeps one production implementation testable end-to-end.
 */
export async function handleForkPickHost<ViewColumn>(opts: {
  source: ForkSessionSource & { localHost: string };
  pickHost: (agentKey: string) => Promise<{ host?: string; cancelled: boolean }>;
  openFork: (launch: ForkPickHostLaunch<ViewColumn>) => Promise<{ terminalId: string; sessionId: string | null }>;
  recordFork: (edge: ForkPickHostRecord) => void;
  showRejection: (reason: 'no_session' | 'no_agent') => void;
  viewColumn: ViewColumn;
  now: () => number;
}): Promise<void> {
  const dryRun = buildForkSessionRequest(opts.source);
  if (!dryRun.ok) {
    opts.showRejection(dryRun.reason);
    return;
  }

  const picked = await opts.pickHost(dryRun.agentKey);
  if (picked.cancelled) return;

  const request = buildForkSessionRequest(opts.source, { host: picked.host });
  if (!request.ok) {
    opts.showRejection(request.reason);
    return;
  }

  const fork = await opts.openFork({
    prompt: request.prompt,
    strategy: request.strategy,
    host: request.host,
    local: request.local,
    viewColumn: opts.viewColumn,
  });
  opts.recordFork({
    sourceSessionId: request.sessionId,
    sourceHost: request.sourceHost ?? opts.source.localHost,
    forkSessionId: fork.sessionId,
    forkHost: request.host ?? opts.source.localHost,
    agentKey: request.agentKey,
    forkedAt: opts.now(),
    terminalId: fork.terminalId,
  });
}
