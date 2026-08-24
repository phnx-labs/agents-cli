import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

// Minimal vscode mock — the palette handlers show status-bar / error messages;
// the migration receives its VS Code boundary functions explicitly so this
// file stays deterministic when Bun runs it beside other vscode module mocks.
const statusMessages: string[] = [];
const errorMessages: string[] = [];

mock.module('vscode', () => vscodeDouble({
  window: {
    state: { focused: true },
    setStatusBarMessage: (msg: string) => {
      statusMessages.push(msg);
      return { dispose: () => {} };
    },
    showErrorMessage: (msg: string) => {
      errorMessages.push(msg);
      return Promise.resolve(undefined);
    },
  },
  workspace: {},
}));

const watchdog = await import('./watchdog.vscode');

type ExecCall = { file: string; args: string[] };

function fakeGlobalState(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    update(key: string, value: unknown) {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function makeDeps(behavior: 'ok' | 'fail' = 'ok') {
  const calls: ExecCall[] = [];
  const execFileAsync = (file: string, args: string[]) => {
    calls.push({ file, args });
    if (behavior === 'fail') {
      const err = new Error('exit 1') as Error & { stderr?: string };
      err.stderr = 'agents: daemon is not running\n';
      return Promise.reject(err);
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return {
    calls,
    deps: {
      execFileAsync,
      resolveBin: () => Promise.resolve('/fake/bin/agents'),
    },
  };
}

function makeMigrationDeps(
  inspect: { globalValue?: boolean; workspaceValue?: boolean; workspaceFolderValue?: boolean } = {},
  behavior: 'ok' | 'fail' = 'ok',
) {
  const { calls, deps } = makeDeps(behavior);
  return {
    calls,
    deps: {
      ...deps,
      inspectAutoRotate: () => inspect,
      setStatusBarMessage: (message: string) => {
        statusMessages.push(message);
      },
      showErrorMessage: (message: string) => {
        errorMessages.push(message);
      },
    },
  };
}

beforeEach(() => {
  statusMessages.length = 0;
  errorMessages.length = 0;
});

describe('registerWatchdogPaletteCommands', () => {
  test('registers both palette commands', () => {
    const registered = new Map<string, () => Promise<void>>();
    const registerCommand = (id: string, handler: () => Promise<void>) => {
      registered.set(id, handler);
      return { dispose: () => {} };
    };
    const disposables = watchdog.registerWatchdogPaletteCommands(
      registerCommand as never,
      makeDeps().deps,
    );
    expect(disposables).toHaveLength(2);
    expect([...registered.keys()].sort()).toEqual([
      'agents.watchdogDisable',
      'agents.watchdogEnable',
    ]);
  });

  test('enable shells out to `agents watchdog on` (argv, no shell string) and confirms', async () => {
    const registered = new Map<string, () => Promise<void>>();
    const { calls, deps } = makeDeps();
    watchdog.registerWatchdogPaletteCommands(
      ((id: string, handler: () => Promise<void>) => {
        registered.set(id, handler);
        return { dispose: () => {} };
      }) as never,
      deps,
    );
    await registered.get('agents.watchdogEnable')!();
    expect(calls).toEqual([{ file: '/fake/bin/agents', args: ['watchdog', 'on'] }]);
    expect(statusMessages.some((m) => m.includes('Watchdog turned on'))).toBe(true);
    expect(errorMessages).toHaveLength(0);
  });

  test('disable shells out to `agents watchdog off` and confirms', async () => {
    const registered = new Map<string, () => Promise<void>>();
    const { calls, deps } = makeDeps();
    watchdog.registerWatchdogPaletteCommands(
      ((id: string, handler: () => Promise<void>) => {
        registered.set(id, handler);
        return { dispose: () => {} };
      }) as never,
      deps,
    );
    await registered.get('agents.watchdogDisable')!();
    expect(calls).toEqual([{ file: '/fake/bin/agents', args: ['watchdog', 'off'] }]);
    expect(statusMessages.some((m) => m.includes('Watchdog turned off'))).toBe(true);
  });

  test('a nonzero CLI exit surfaces an error toast quoting stderr', async () => {
    const registered = new Map<string, () => Promise<void>>();
    const { deps } = makeDeps('fail');
    watchdog.registerWatchdogPaletteCommands(
      ((id: string, handler: () => Promise<void>) => {
        registered.set(id, handler);
        return { dispose: () => {} };
      }) as never,
      deps,
    );
    await registered.get('agents.watchdogEnable')!();
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toContain('agents watchdog on failed');
    expect(errorMessages[0]).toContain('daemon is not running');
    expect(statusMessages).toHaveLength(0);
  });
});

describe('migrateAutoRotateSettingOnce', () => {
  test('no explicit autoRotate setting → no CLI call, flag set (runs once)', async () => {
    const { calls, deps } = makeMigrationDeps();
    const state = fakeGlobalState();
    await watchdog.migrateAutoRotateSettingOnce(state, deps);
    expect(calls).toHaveLength(0);
    expect(state.data.get(watchdog.WATCHDOG_ROTATE_MIGRATED_KEY)).toBe(true);
  });

  test('autoRotate explicitly true → no migration', async () => {
    const { calls, deps } = makeMigrationDeps({ globalValue: true });
    const state = fakeGlobalState();
    await watchdog.migrateAutoRotateSettingOnce(state, deps);
    expect(calls).toHaveLength(0);
    expect(state.data.get(watchdog.WATCHDOG_ROTATE_MIGRATED_KEY)).toBe(true);
  });

  test('autoRotate explicitly false → CLI watchdog rotate off once + one-time note', async () => {
    const { calls, deps } = makeMigrationDeps({ globalValue: false });
    const state = fakeGlobalState();
    await watchdog.migrateAutoRotateSettingOnce(state, deps);
    expect(calls).toEqual([{ file: '/fake/bin/agents', args: ['watchdog', 'rotate', 'off'] }]);
    expect(state.data.get(watchdog.WATCHDOG_ROTATE_MIGRATED_KEY)).toBe(true);
    expect(statusMessages.some((m) => m.includes('Migrated watchdog setting'))).toBe(true);

    // Second activation: the flag short-circuits — never runs again.
    await watchdog.migrateAutoRotateSettingOnce(state, deps);
    expect(calls).toHaveLength(1);
  });

  test('workspace-level explicit false also migrates', async () => {
    const { calls, deps } = makeMigrationDeps({ workspaceValue: false });
    await watchdog.migrateAutoRotateSettingOnce(fakeGlobalState(), deps);
    expect(calls).toEqual([{ file: '/fake/bin/agents', args: ['watchdog', 'rotate', 'off'] }]);
  });

  test('CLI failure → error toast, flag left unset so the next activation retries', async () => {
    const { deps } = makeMigrationDeps({ globalValue: false }, 'fail');
    const state = fakeGlobalState();
    await watchdog.migrateAutoRotateSettingOnce(state, deps);
    expect(state.data.get(watchdog.WATCHDOG_ROTATE_MIGRATED_KEY)).toBeUndefined();
    expect(errorMessages.some((m) => m.includes('Could not migrate'))).toBe(true);
  });

  test('flag already set → no-op even with an explicit false', async () => {
    const { calls, deps } = makeMigrationDeps({ globalValue: false });
    const state = fakeGlobalState({ [watchdog.WATCHDOG_ROTATE_MIGRATED_KEY]: true });
    await watchdog.migrateAutoRotateSettingOnce(state, deps);
    expect(calls).toHaveLength(0);
  });
});
