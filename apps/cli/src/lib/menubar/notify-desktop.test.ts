import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMenubarNotifyArgs,
  buildOsascriptNotifyArgs,
  notifyDesktop,
} from './notify-desktop.js';

describe('buildMenubarNotifyArgs', () => {
  it('emits --title/--body and omits optional flags when absent', () => {
    expect(buildMenubarNotifyArgs({ title: 'T', body: 'B' })).toEqual([
      '--notify',
      '--title',
      'T',
      '--body',
      'B',
    ]);
  });

  it('includes subtitle and action when present', () => {
    expect(
      buildMenubarNotifyArgs({
        title: 'Routine finished',
        body: 'Completed in 3s',
        subtitle: 'nightly',
        action: 'open:/tmp/report.md',
      }),
    ).toEqual([
      '--notify',
      '--title',
      'Routine finished',
      '--body',
      'Completed in 3s',
      '--subtitle',
      'nightly',
      '--action',
      'open:/tmp/report.md',
    ]);
  });

  it('passes title/body verbatim as separate argv (no shell interpolation)', () => {
    // The one-shot receives each field as its own argv entry, so quotes and
    // shell metacharacters are inert — no escaping needed, no injection surface.
    const args = buildMenubarNotifyArgs({ title: 'a "b" $c', body: 'x; rm -rf /' });
    expect(args[args.indexOf('--title') + 1]).toBe('a "b" $c');
    expect(args[args.indexOf('--body') + 1]).toBe('x; rm -rf /');
  });
});

describe('buildOsascriptNotifyArgs (degradation path)', () => {
  it('builds an AppleScript display-notification statement', () => {
    expect(buildOsascriptNotifyArgs({ title: 'Routine overdue', body: 'catchup' })).toEqual([
      '-e',
      'display notification "catchup" with title "Routine overdue"',
    ]);
  });

  it('escapes embedded double-quotes and backslashes so the script stays well-formed', () => {
    const [flag, script] = buildOsascriptNotifyArgs({
      title: 'say "hi"',
      body: 'path C:\\x',
      subtitle: 'sub "q"',
    });
    expect(flag).toBe('-e');
    expect(script).toBe(
      'display notification "path C:\\\\x" with title "say \\"hi\\"" subtitle "sub \\"q\\""',
    );
  });
});

describe('notifyDesktop — missing notifier must not crash the daemon', () => {
  const origPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = origPath;
  });

  // Regression parity with overdue.test.ts: on a headless box the notifier
  // (notify-send / osascript) is absent. spawn() reports that as an ASYNC
  // 'error' event, not a synchronous throw — the module attaches an 'error'
  // listener so Node does not re-throw ENOENT as an uncaught exception and take
  // the daemon down. Emptying PATH forces ENOENT on the PATH-resolved notifier.
  it('swallows the notifier ENOENT and survives', async () => {
    process.env.PATH = '';
    expect(() =>
      notifyDesktop({ title: 'T', body: 'B', action: 'routines:list' }),
    ).not.toThrow();
    // Let the async spawn 'error' event fire on the next libuv turn.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(true).toBe(true);
  });
});
