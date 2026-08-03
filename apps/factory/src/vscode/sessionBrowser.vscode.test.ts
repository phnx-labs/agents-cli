import { describe, expect, test } from 'bun:test';
import { buildAgentLaunchCommand } from '../core/agents';
import { buildSessionBrowserRows, type SessionBrowserSessionRow } from '../core/sessionBrowser';
import {
  LatestSessionBrowserRequest,
  createForkPickSessionCommand,
  loadBrowsableSessions,
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
  show(): void {}
  hide(): void { this.hideListener?.(); }
  onDidTriggerButton(listener: (button: Button) => void): unknown { this.buttonListener = listener; return {}; }
  onDidAccept(listener: () => void): unknown { this.acceptListener = listener; return {}; }
  onDidHide(listener: () => void): unknown { this.hideListener = listener; return {}; }
  triggerButton(button: Button): void { this.buttonListener?.(button); }
  accept(): void { this.acceptListener?.(); }
}

describe('session browser extension-host seam', () => {
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
            id: 'current-outside-limit', shortId: 'current-', agent: 'claude', timestamp: '2026-01-01T00:00:00Z',
          }]), stderr: '' };
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
  });

  test('registered command -> QuickPick load/switch/reload/accept -> fork -> queued launch uses the real seams', async () => {
    const commands: string[] = [];
    const run: SessionBrowserRunner = async (args) => {
      commands.push(args);
      const remote = args.includes("--host 'yosemite-s0'");
      return { stdout: JSON.stringify(remote ? [{
        id: 'remote-session', shortId: 'remote-s', agent: 'claude', machine: 'yosemite-s0',
        cwd: '/srv/exact repo', timestamp: '2026-08-03T00:00:00Z', topic: 'Fix picker',
      }] : []), stderr: '' };
    };
    type Item = { label: string; row?: SessionBrowserSessionRow };
    const quickPick = new FakeQuickPick<Item, 'switch' | 'reload'>();
    let queued = '';
    const registered = createForkPickSessionCommand(async () => {
      const picked = await runSessionBrowserPicker({
        quickPick,
        switchButton: 'switch',
        reloadButton: 'reload',
        localMachine: 'zion',
        chooseDevice: async () => ({ device: 'yosemite-s0', cancelled: false }),
        loadItems: async device => {
          const sessions = await loadBrowsableSessions(run, { device, localMachine: 'zion', limit: 60, quote });
          return buildSessionBrowserRows(sessions, { localMachine: 'zion' })
            .filter((row): row is SessionBrowserSessionRow => row.kind === 'session')
            .map(row => ({ label: row.label, row }));
        },
        emptyItem: () => ({ label: 'empty' }),
        errorItem: message => ({ label: message }),
      });
      if (!picked) throw new Error('expected a picked session');
      await runPickedSessionFork({
        row: picked,
        localMachine: 'zion',
        showError: message => { throw new Error(message); },
        launch: async request => {
          queued = `${buildAgentLaunchCommand(
            request.agentKey, 'new-session', undefined, undefined, undefined,
            request.strategy, undefined, request.host, request.local, request.remoteCwd,
          )} && queue ${request.prompt}`;
          return true;
        },
      });
    });
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
