import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  formatUnreachableNote,
  isActivityHookError,
  isManifestHookError,
  registerActivityCommand,
  resolveActivityGrouping,
  resolveActivityScope,
} from './activity.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function activityCmd(): Command {
  const program = new Command();
  registerActivityCommand(program);
  const cmd = program.commands.find((c) => c.name() === 'activity');
  if (!cmd) throw new Error('activity command not registered');
  return cmd;
}

describe('activity command option/alias wiring', () => {
  it('registers the fleet + grouping flags and their aliases', () => {
    const longs = activityCmd().options.map((o) => o.long);
    for (const flag of [
      '--local', '--host', '--device', '--devices-all', '--hosts-all',
      '--group-by', '--flat', '--filter', '--milestones', '--all', '--json', '--since', '--limit',
    ]) {
      expect(longs).toContain(flag);
    }
  });

  it('parses --devices-all --group-by --filter --local without an unknown-option error', () => {
    const cmd = activityCmd();
    cmd.exitOverride(); // never process.exit; the async action is not reached here
    expect(() =>
      cmd.parseOptions(['--devices-all', '--group-by', 'project', '--filter', 'RUSH-1', '--local']),
    ).not.toThrow();
    const parsed = cmd.opts();
    expect(parsed.devicesAll).toBe(true);
    expect(parsed.groupBy).toBe('project');
    expect(parsed.filter).toBe('RUSH-1');
    expect(parsed.local).toBe(true);
  });

  it('accepts --hosts-all and repeatable --device', () => {
    const cmd = activityCmd();
    cmd.exitOverride();
    expect(() => cmd.parseOptions(['--hosts-all'])).not.toThrow();
    expect(cmd.opts().hostsAll).toBe(true);

    const cmd2 = activityCmd();
    cmd2.exitOverride();
    cmd2.parseOptions(['--device', 'zion', '--device', 'mac-mini']);
    expect(cmd2.opts().device).toEqual(['zion', 'mac-mini']);
  });
});

describe('resolveActivityGrouping', () => {
  it('groups by project when nothing is asked for', () => {
    expect(resolveActivityGrouping({})).toBe('project');
  });

  it('honours an explicit dimension', () => {
    expect(resolveActivityGrouping({ groupBy: 'device' })).toBe('device');
    expect(resolveActivityGrouping({ groupBy: 'agent' })).toBe('agent');
  });

  it('drops back to a flat stream for --flat and --group-by none', () => {
    expect(resolveActivityGrouping({ flat: true })).toBeUndefined();
    expect(resolveActivityGrouping({ groupBy: 'none' })).toBeUndefined();
    // --flat wins over a dimension: it is the explicit "no buckets" ask.
    expect(resolveActivityGrouping({ flat: true, groupBy: 'device' })).toBeUndefined();
  });

  it('rejects an unknown dimension instead of silently defaulting', () => {
    expect(() => resolveActivityGrouping({ groupBy: 'repo' })).toThrow(/project, device, agent, none/);
  });
});

describe('resolveActivityScope', () => {
  it('reads the whole fleet by default', () => {
    expect(resolveActivityScope({}, 'zion', false)).toEqual({ includeLocal: true, wantRemote: true });
  });

  it('--local skips the fan-out', () => {
    expect(resolveActivityScope({ local: true }, 'zion', false)).toEqual({ includeLocal: true, wantRemote: false });
  });

  it('a peer answering the fan-out never re-fans it out', () => {
    // Without this guard, every dialed peer would dial the fleet in turn.
    expect(resolveActivityScope({}, 'zion', true)).toEqual({ includeLocal: true, wantRemote: false });
  });

  it('an explicit --host list scopes to those peers and drops this box', () => {
    const scope = resolveActivityScope({ host: ['mac-mini'] }, 'zion', false);
    expect(scope.includeLocal).toBe(false);
    expect(scope.wantRemote).toBe(true);
    expect(scope.remoteHosts).toEqual(['mac-mini']);
  });

  it('--host <self> reads locally with no SSH hop', () => {
    const scope = resolveActivityScope({ host: ['zion'] }, 'zion', false);
    expect(scope.includeLocal).toBe(true);
    expect(scope.wantRemote).toBe(false);
  });
});

describe('formatUnreachableNote', () => {
  it('says nothing when every peer answered', () => {
    expect(formatUnreachableNote([])).toBe('');
  });

  it('reports offline peers once, compactly, instead of a line each', () => {
    expect(stripAnsi(formatUnreachableNote(['winbox']))).toBe('  · 1 device unreachable: winbox\n\n');
    expect(stripAnsi(formatUnreachableNote(['a', 'b', 'c', 'd', 'e', 'f'])))
      .toBe('  · 6 devices unreachable: a, b, c, d +2\n\n');
  });
});

describe('isActivityHookError', () => {
  it('keeps a failure that would leave the activity log unwritten', () => {
    expect(isActivityHookError('activity-log-intent: script not found')).toBe(true);
    expect(isActivityHookError('activity-log-result: script not found')).toBe(true);
  });

  it('drops unrelated hook noise that belongs to agents doctor', () => {
    // The five wrapped lines this command used to print above every timeline.
    expect(isActivityHookError('inject-session-id: script not found in user or system hooks dir')).toBe(false);
    expect(isActivityHookError('register-session-pid: script not found in user or system hooks dir')).toBe(false);
  });
});

describe('isManifestHookError', () => {
  const manifestNames = ['activity-log-intent', 'activity-log-result', 'inject-session-id'];

  it('keeps an agent-level abort that names no hook — it leaves the log unwritten', () => {
    // A corrupt settings.json aborts registration for the whole agent; filtering
    // it out would silently stop activity logging for that version.
    expect(isManifestHookError('Failed to parse settings.json', manifestNames)).toBe(false);
    expect(isManifestHookError('Failed to write agents-cli-hooks.ts: EACCES', manifestNames)).toBe(false);
  });

  it('attributes per-hook failures to their hook', () => {
    expect(isManifestHookError('inject-session-id: script not found', manifestNames)).toBe(true);
    expect(isManifestHookError('activity-log-intent: script not found', manifestNames)).toBe(true);
  });
});
