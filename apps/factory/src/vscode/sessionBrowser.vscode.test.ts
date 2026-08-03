import { describe, expect, test } from 'bun:test';
import { buildAgentLaunchCommand } from '../core/agents';
import { buildSessionBrowserRows, type SessionBrowserSessionRow } from '../core/sessionBrowser';
import {
  LatestSessionBrowserRequest,
  handleForkPickedSession,
  loadBrowsableSessions,
  registerForkRecapCommand,
  registerForkPickSessionCommand,
  runPickedSessionFork,
  runSessionBrowserPicker,
  type SessionBrowserQuickPick,
  type SessionBrowserRunner,
} from './sessionBrowser.vscode';

const quote = (value: string) => `'${value}'`;

class FakeQuickPick<Item, Button> implements SessionBrowserQuickPick<Item, Button> {
  title = '';
  busy = false;
  items: readonly Item[] = [];
  selectedItems: readonly Item[] = [];
  private buttonListener?: (button: Button) => void;
  private acceptListener?: () => void;
  private hideListener?: () => void;
  private hidden = false;
  show(): void {}
  hide(): void { this.hidden = true; this.hideListener?.(); }
  onDidTriggerButton(listener: (button: Button) => void): unknown { this.buttonListener = listener; return {}; }
  onDidAccept(listener: () => void): unknown { this.acceptListener = listener; return {}; }
  onDidHide(listener: () => void): unknown { this.hideListener = listener; return {}; }
  triggerButton(button: Button): void { this.buttonListener?.(button); }
  accept(): void { this.acceptListener?.(); }
  get isHidden(): boolean { return this.hidden; }
}

describe('session browser extension-host seam', () => {
  test('picked Claude source id stays only in the queued continue prompt', async () => {
    const historicalId = '51a57597-3e08-40fc-9d2b-ca623458dc55';
    const launches: Record<string, unknown>[] = [];
    const session = {
      id: historicalId,
      shortId: '51a57597',
      agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z',
    };

    for (const row of [
      { machine: 'zion', remote: false, cwd: '/Users/muqsit/agents-cli' },
      { machine: 'yosemite-s0', remote: true, cwd: '/srv/agents-cli' },
    ]) {
      await runPickedSessionFork({
        row: {
          kind: 'session',
          session: { ...session, cwd: row.cwd },
          machine: row.machine,
          remote: row.remote,
          current: false,
          label: historicalId,
          description: '',
          detail: '',
        },
        localMachine: 'zion',
        launch: async request => { launches.push(request); return true; },
        showError: message => { throw new Error(message); },
      });
    }

    expect(launches).toHaveLength(2);
    for (const request of launches) {
      expect(request.prompt).toBe(`/continue ${historicalId}`);
      expect(request).not.toHaveProperty('sessionId');
    }
    expect(launches[0]).toMatchObject({
      agentKey: 'claude', strategy: 'balanced', local: true,
      host: undefined, cwd: '/Users/muqsit/agents-cli', remoteCwd: undefined,
    });
    expect(launches[1]).toMatchObject({
      agentKey: 'claude', strategy: 'balanced', local: false,
      host: 'yosemite-s0', cwd: undefined, remoteCwd: '/srv/agents-cli',
    });
  });

  test('Agents: Fork (Recap) queues only a context recap in a new remote sibling', async () => {
    const historicalId = '51a57597-3e08-40fc-9d2b-ca623458dc55';
    const row: SessionBrowserSessionRow = {
      kind: 'session',
      session: {
        id: historicalId,
        shortId: '51a57597',
        agent: 'claude',
        cwd: '/srv/exact repo',
        timestamp: '2026-08-03T00:00:00Z',
      },
      machine: 'yosemite-s0',
      remote: true,
      current: false,
      label: historicalId,
      description: '',
      detail: '',
    };
    let registeredId = '';
    let registered!: () => Promise<void>;
    let queued = '';
    registerForkRecapCommand((id, callback) => {
      registeredId = id;
      registered = callback;
      return {};
    }, () => handleForkPickedSession({
      intent: 'recap',
      currentSession: () => ({ sessionId: 'different-current-id', device: 'zion' }),
      pickSession: async () => row,
      localMachine: 'zion',
      resolveAgentConfig: agentKey => ({ agentKey }),
      launchQueued: async (_config, request) => {
        const launch = buildAgentLaunchCommand(
          request.agentKey,
          'new-sibling-id',
          undefined,
          undefined,
          undefined,
          request.strategy,
          undefined,
          { host: request.host, local: request.local, remoteCwd: request.remoteCwd },
        );
        queued = `${launch} && queue ${request.prompt}`;
      },
      showError: message => { throw new Error(message); },
      showStatus: () => {},
    }));

    await registered();

    const [launch, prompt] = queued.split(' && queue ');
    expect(registeredId).toBe('agents.forkRecap');
    expect(launch).toContain("--host 'yosemite-s0' --remote-cwd '/srv/exact repo'");
    expect(launch).toContain('--session-id new-sibling-id');
    expect(launch).not.toContain(historicalId);
    expect(launch).not.toContain('--resume');
    expect(prompt).toBe(`/recap ${historicalId}`);
    expect(prompt).not.toContain('/continue');
  });

  test('only the latest overlapping picker load may publish items or clear busy', async () => {
    const requests = new LatestSessionBrowserRequest();
    const published: string[] = [];
    let busy = true;
    let resolveFirst!: () => void;
    const firstWait = new Promise<void>(resolve => { resolveFirst = resolve; });

    const load = async (name: string, wait: Promise<void>) => {
      const request = requests.begin();
      await wait;
      if (!request.current()) return;
      published.push(name);
      busy = false;
    };

    const first = load('local stale result', firstWait);
    const second = load('remote latest result', Promise.resolve());
    await second;
    resolveFirst();
    await first;

    expect(published).toEqual(['remote latest result']);
    expect(busy).toBe(false);
  });

  test('hiding the picker invalidates an in-flight load before disposal', () => {
    const requests = new LatestSessionBrowserRequest();
    const request = requests.begin();
    requests.invalidate();
    expect(request.current()).toBe(false);
  });

  test('cancelling a device switch reloads after invalidating an in-flight request', async () => {
    const quickPick = new FakeQuickPick<{ label: string }, 'switch' | 'reload'>();
    let resolveInitial!: (items: { label: string }[]) => void;
    const initial = new Promise<{ label: string }[]>(resolve => { resolveInitial = resolve; });
    let loads = 0;
    const picker = runSessionBrowserPicker({
      quickPick,
      switchButton: 'switch',
      reloadButton: 'reload',
      localMachine: 'zion',
      loadItems: async () => ++loads === 1 ? initial : [{ label: 'reloaded local session' }],
      chooseDevice: async () => ({ cancelled: true }),
      emptyItem: () => ({ label: 'empty' }),
      errorItem: message => ({ label: message }),
    });
    await Bun.sleep(0);
    quickPick.triggerButton('switch');
    await Bun.sleep(0);
    resolveInitial([{ label: 'stale local session' }]);
    await Bun.sleep(0);
    expect(quickPick.busy).toBe(false);
    expect(quickPick.items).toEqual([{ label: 'reloaded local session' }]);
    quickPick.hide();
    expect(await picker).toBeNull();
  });

  test('labels the shared picker for the recap intent', async () => {
    const quickPick = new FakeQuickPick<{ label: string }, 'switch' | 'reload'>();
    const picker = runSessionBrowserPicker({
      quickPick,
      title: 'Agents: Fork (Recap)',
      switchButton: 'switch',
      reloadButton: 'reload',
      localMachine: 'zion',
      loadItems: async () => [],
      chooseDevice: async () => ({ cancelled: true }),
      emptyItem: () => ({ label: 'empty' }),
      errorItem: message => ({ label: message }),
    });

    await Bun.sleep(0);
    expect(quickPick.title).toBe('Agents: Fork (Recap) · zion');
    quickPick.hide();
    expect(await picker).toBeNull();
  });

  test('preserves an explicitly selected unreachable-device CLI boundary error instead of returning an empty list', async () => {
    const run: SessionBrowserRunner = async () => ({ stdout: '', stderr: 'ssh: connect to host offline: No route to host\n' });
    expect(loadBrowsableSessions(run, {
      device: 'offline', localMachine: 'zion', limit: 60, quote,
    })).rejects.toThrow('ssh: connect to host offline: No route to host');
  });

  test('keeps valid local fleet rows when unrelated devices emit best-effort skip notices', async () => {
    const run: SessionBrowserRunner = async () => ({
      stdout: JSON.stringify([{ id: 'local', shortId: 'local', agent: 'claude', timestamp: '2026-08-03T00:00:00Z' }]),
      stderr: 'gpu-box: unreachable or no agents CLI — skipped\n',
    });
    const sessions = await loadBrowsableSessions(run, { localMachine: 'zion', limit: 60, quote });
    expect(sessions.map(session => session.id)).toEqual(['local']);
  });

  test('keeps the ordinary 60-row query and fetches the invoked session when truncation omitted it', async () => {
    const calls: string[] = [];
    const recent = Array.from({ length: 60 }, (_, index) => ({
      id: `recent-${index}`, shortId: `recent-${index}`, agent: 'claude', timestamp: '2026-08-03T00:00:00Z',
    }));
    const run: SessionBrowserRunner = async (args) => {
      calls.push(args);
      return args.startsWith('sessions --all')
        ? { stdout: JSON.stringify(recent), stderr: '' }
        : { stdout: JSON.stringify([{
            context: 'headless', kind: 'claude', host: 'tmux', pid: 4312,
            sessionId: 'current-outside-limit', cwd: '/repo', topic: 'Repair picker',
            project: 'agents-cli', machine: 'zion', status: 'working',
            startedAtMs: Date.parse('2026-01-01T00:00:00Z'),
          }]), stderr: 'gpu-box: unreachable or no agents CLI — skipped\n' };
    };

    const sessions = await loadBrowsableSessions(run, {
      localMachine: 'zion', limit: 60, currentSessionId: 'current-outside-limit', quote,
    });
    expect(calls).toEqual([
      'sessions --all -n 60 --json',
      'sessions --active --json',
    ]);
    expect(sessions).toHaveLength(61);
    expect(sessions.at(-1)?.id).toBe('current-outside-limit');
    expect(sessions.at(-1)?.agent).toBe('claude');
    expect(sessions.at(-1)?.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  test('an explicitly selected device surfaces active-metadata stderr', async () => {
    const recent = Array.from({ length: 60 }, (_, index) => ({
      id: `recent-${index}`, shortId: `recent-${index}`, agent: 'claude', timestamp: '2026-08-03T00:00:00Z',
    }));
    const run: SessionBrowserRunner = async args => args.startsWith('sessions --all')
      ? { stdout: JSON.stringify(recent), stderr: '' }
      : { stdout: '[]', stderr: 'remote agents CLI unavailable\n' };
    expect(loadBrowsableSessions(run, {
      device: 'mac-mini', localMachine: 'zion', limit: 60,
      currentSessionId: 'missing', currentSessionDevice: 'mac-mini', quote,
    })).rejects.toThrow('remote agents CLI unavailable');
  });

  test('hiding invalidates an in-flight load before it can mutate the picker', async () => {
    type Item = { label: string; row?: SessionBrowserSessionRow };
    const quickPick = new FakeQuickPick<Item, 'switch' | 'reload'>();
    let resolveLoad!: (items: Item[]) => void;
    const picker = runSessionBrowserPicker({
      quickPick,
      switchButton: 'switch', reloadButton: 'reload', localMachine: 'zion',
      loadItems: () => new Promise(resolve => { resolveLoad = resolve; }),
      chooseDevice: async () => ({ cancelled: true }),
      emptyItem: () => ({ label: 'empty' }),
      errorItem: message => ({ label: message }),
    });
    quickPick.hide();
    resolveLoad([{ label: 'stale result' }]);
    expect(await picker).toBeNull();
    await Bun.sleep(0);
    expect(quickPick.items).toEqual([]);
    expect(quickPick.busy).toBe(true);
  });

  test('pins active metadata without a start timestamp instead of throwing', async () => {
    const run: SessionBrowserRunner = async (args) => args.startsWith('sessions --all')
      ? { stdout: '[]', stderr: '' }
      : { stdout: JSON.stringify([{ sessionId: 'current-no-time', kind: 'codex', cwd: '/repo' }]), stderr: '' };
    const sessions = await loadBrowsableSessions(run, {
      localMachine: 'zion', limit: 60, currentSessionId: 'current-no-time', quote,
    });
    expect(sessions[0]?.timestamp).toBe('1970-01-01T00:00:00.000Z');
  });

  test('registered command -> QuickPick load/switch/reload/accept -> fork -> queued launch uses the real seams', async () => {
    const commands: string[] = [];
    const run: SessionBrowserRunner = async (args) => {
      commands.push(args);
      const remote = args.includes("--host 'yosemite-s0'");
      return { stdout: JSON.stringify(remote ? [{
        id: 'remote-session', shortId: 'remote-s', agent: 'claude',
        cwd: '/srv/exact repo', timestamp: '2026-08-03T00:00:00Z', topic: 'Fix picker',
      }] : []), stderr: '' };
    };
    type Item = { label: string; row?: SessionBrowserSessionRow };
    const quickPick = new FakeQuickPick<Item, 'switch' | 'reload'>();
    let queued = '';
    let registeredId = '';
    let registered!: () => Promise<void>;
    registerForkPickSessionCommand((id, callback) => {
      registeredId = id;
      registered = callback;
      return {};
    }, async () => {
      await handleForkPickedSession({
        currentSession: () => ({ sessionId: 'current-session' }),
        localMachine: 'zion',
        pickSession: () => runSessionBrowserPicker({
          quickPick,
          switchButton: 'switch',
          reloadButton: 'reload',
          localMachine: 'zion',
          chooseDevice: async () => ({ device: 'yosemite-s0', cancelled: false }),
          loadItems: async device => {
            const sessions = await loadBrowsableSessions(run, { device, localMachine: 'zion', limit: 60, quote });
            return buildSessionBrowserRows(sessions, { localMachine: 'zion', browsedMachine: device })
              .filter((row): row is SessionBrowserSessionRow => row.kind === 'session')
              .map(row => ({ label: row.label, row }));
          },
          emptyItem: () => ({ label: 'empty' }),
          errorItem: message => ({ label: message }),
        }),
        resolveAgentConfig: agentKey => ({ agentKey }),
        launchQueued: async (_config, request) => {
          queued = `${buildAgentLaunchCommand(
            request.agentKey, 'new-session', undefined, undefined, undefined,
            request.strategy, undefined, {
              host: request.host,
              local: request.local,
              remoteCwd: request.remoteCwd,
            },
          )} && queue ${request.prompt}`;
        },
        showError: message => { throw new Error(message); },
        showStatus: () => {},
      });
    });
    expect(registeredId).toBe('agents.forkPickSession');
    const commandRun = registered();
    await Bun.sleep(0);
    quickPick.triggerButton('switch');
    await Bun.sleep(0);
    quickPick.triggerButton('reload');
    await Bun.sleep(0);
    quickPick.selectedItems = [quickPick.items[0]];
    quickPick.accept();
    await commandRun;

    expect(commands).toEqual([
      'sessions --all -n 60 --json',
      "sessions --all -n 60 --json --host 'yosemite-s0'",
      "sessions --all -n 60 --json --host 'yosemite-s0'",
    ]);
    expect(queued).toContain("--host 'yosemite-s0' --remote-cwd '/srv/exact repo'");
    expect(queued).toContain('queue /continue remote-session');
  });
});
