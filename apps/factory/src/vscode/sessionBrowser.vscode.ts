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
  if (opts.device && listed.stderr.trim()) throw new Error(listed.stderr.trim());
  const sessions = parseSessionList(listed.stdout);

  const browsingCurrentDevice = (opts.device ?? opts.localMachine) ===
    (opts.currentSessionDevice ?? opts.localMachine);
  if (!opts.currentSessionId || !browsingCurrentDevice ||
      sessions.some(session => session.id === opts.currentSessionId || session.shortId === opts.currentSessionId)) {
    return sessions;
  }

  const exact = await run(`sessions --active --json${scope}`, {
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  if (exact.stderr.trim()) throw new Error(exact.stderr.trim());
  const active = JSON.parse(exact.stdout);
  const current = Array.isArray(active)
    ? active.find(session => session?.id === opts.currentSessionId || session?.shortId === opts.currentSessionId)
    : undefined;
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

export interface SessionBrowserQuickPick<Item, Button> {
  title: string | undefined;
  busy: boolean;
  items: readonly Item[];
  selectedItems: readonly Item[];
  show(): void;
  hide(): void;
  onDidTriggerButton(listener: (button: Button) => void): unknown;
  onDidAccept(listener: () => void): unknown;
  onDidHide(listener: () => void): unknown;
}

export function createForkPickSessionCommand(run: () => Promise<void>): () => Promise<void> {
  return run;
}

export async function runSessionBrowserPicker<Item extends { row?: SessionBrowserSessionRow }, Button>(opts: {
  quickPick: SessionBrowserQuickPick<Item, Button>;
  switchButton: Button;
  reloadButton: Button;
  localMachine: string;
  loadItems: (device?: string) => Promise<Item[]>;
  chooseDevice: (current?: string) => Promise<{ device?: string; cancelled: boolean }>;
  emptyItem: (device?: string) => Item;
  errorItem: (message: string) => Item;
}): Promise<SessionBrowserSessionRow | null> {
  let device: string | undefined;
  let switching = false;
  const requests = new LatestSessionBrowserRequest();

  const load = async (): Promise<void> => {
    const request = requests.begin();
    const loadingDevice = device;
    opts.quickPick.title = `Agents: Fork (Pick Session) · ${loadingDevice ?? opts.localMachine}`;
    opts.quickPick.busy = true;
    opts.quickPick.items = [];
    try {
      const items = await opts.loadItems(loadingDevice);
      if (!request.current()) return;
      opts.quickPick.items = items.length > 0 ? items : [opts.emptyItem(loadingDevice)];
    } catch (error: any) {
      if (!request.current()) return;
      const message = (error?.stderr || error?.message || String(error)).trim().split('\n')[0];
      opts.quickPick.items = [opts.errorItem(message)];
    } finally {
      if (request.current()) opts.quickPick.busy = false;
    }
  };

  return new Promise(resolve => {
    opts.quickPick.onDidTriggerButton(async button => {
      if (button === opts.reloadButton) {
        void load();
        return;
      }
      if (button !== opts.switchButton) return;
      switching = true;
      opts.quickPick.hide();
      const chosen = await opts.chooseDevice(device);
      switching = false;
      opts.quickPick.show();
      if (chosen.cancelled) return;
      device = chosen.device;
      void load();
    });
    opts.quickPick.onDidAccept(() => {
      const picked = opts.quickPick.selectedItems[0];
      if (!picked?.row) return;
      resolve(picked.row);
      opts.quickPick.hide();
    });
    opts.quickPick.onDidHide(() => {
      if (!switching) resolve(null);
    });
    opts.quickPick.show();
    void load();
  });
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
