import type { BrowsableSession } from '../core/sessionBrowser';
import type { RunStrategy } from '../core/agents';
import { buildForkSessionRequest } from '../core/forkSession';
import { forkHostForSession, type SessionBrowserSessionRow } from '../core/sessionBrowser';

export interface SessionBrowserRunResult {
  stdout: string;
  stderr: string;
}

export type SessionBrowserRunner = (
  args: string,
  options: { maxBuffer: number; timeout: number },
) => Promise<SessionBrowserRunResult>;

function parseSessionList(stdout: string): BrowsableSession[] {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((session): session is BrowsableSession =>
    !!session && typeof session === 'object' && typeof session.id === 'string');
}

export async function loadBrowsableSessions(
  run: SessionBrowserRunner,
  opts: {
    device?: string;
    localMachine: string;
    limit: number;
    currentSessionId?: string | null;
    currentSessionDevice?: string;
    quote: (value: string) => string;
  },
): Promise<BrowsableSession[]> {
  const scope = opts.device ? ` --host ${opts.quote(opts.device)}` : '';
  const timeout = opts.device ? 45_000 : 20_000;
  const listed = await run(`sessions --all -n ${opts.limit} --json${scope}`, {
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  if (listed.stderr.trim()) throw new Error(listed.stderr.trim());
  const sessions = parseSessionList(listed.stdout);

  const browsingCurrentDevice = (opts.device ?? opts.localMachine) ===
    (opts.currentSessionDevice ?? opts.localMachine);
  if (!opts.currentSessionId || !browsingCurrentDevice ||
      sessions.some(session => session.id === opts.currentSessionId || session.shortId === opts.currentSessionId)) {
    return sessions;
  }

  const exact = await run(`sessions ${opts.quote(opts.currentSessionId)} --json${scope}`, {
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  if (exact.stderr.trim()) throw new Error(exact.stderr.trim());
  const detail = JSON.parse(exact.stdout);
  const current = detail?.session ?? detail;
  if (current && typeof current === 'object' && typeof current.id === 'string') {
    sessions.push(current as BrowsableSession);
  }
  return sessions;
}

export class LatestSessionBrowserRequest {
  private generation = 0;

  begin(): { current: () => boolean } {
    const requestGeneration = ++this.generation;
    return { current: () => requestGeneration === this.generation };
  }
}

export async function runPickedSessionFork(opts: {
  row: SessionBrowserSessionRow;
  localMachine: string;
  launch: (request: {
    agentKey: string;
    prompt: string;
    strategy?: RunStrategy;
    host?: string;
    local: boolean;
    cwd?: string;
    remoteCwd?: string;
  }) => Promise<boolean>;
  showError: (message: string) => void;
}): Promise<boolean> {
  const request = buildForkSessionRequest({
    sessionId: opts.row.session.id,
    agentKey: opts.row.session.agent,
    host: forkHostForSession(opts.row.session, opts.localMachine),
  });
  if (!request.ok) {
    opts.showError(request.reason === 'no_session'
      ? `Session ${opts.row.session.shortId} has no id to fork.`
      : `Session ${opts.row.session.shortId} has no agent harness to fork with.`);
    return false;
  }

  return opts.launch({
    ...request,
    cwd: request.local ? opts.row.session.cwd : undefined,
    remoteCwd: request.local ? undefined : opts.row.session.cwd,
  });
}
