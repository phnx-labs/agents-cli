import { describe, it, expect } from 'bun:test';
import { getCliLaunch, isNodeScriptEntry } from './cli-entry.js';

// Regression for the secrets-broker "Could not start the secrets broker" hang and
// the #315 compiled-binary self-spawn bug. The broker spawn (secrets/agent.ts
// cliSpawn) and every self-relaunch (daemon, teams, message, profiles) route
// through getCliLaunch. The old hand-rolled `[process.execPath, process.argv[1],
// …]` broke on the Bun standalone binary, where process.argv[1] is the virtual
// entry `/$bunfs/root/agents` — passed as an argv element it made the child die
// with "unknown command '/$bunfs/root/agents'", so the broker never bound.
describe('getCliLaunch', () => {
  it('launches a .js entry through the Node runtime', () => {
    const { command, args } = getCliLaunch(['secrets', '_agent-run'], '/opt/agents/dist/index.js');
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/opt/agents/dist/index.js', 'secrets', '_agent-run']);
  });

  it('runs a compiled binary directly — never re-passes its own path as an arg', () => {
    const { command, args } = getCliLaunch(['secrets', '_agent-run'], '/Users/me/.local/bin/agents');
    expect(command).toBe('/Users/me/.local/bin/agents');
    expect(args).toEqual(['secrets', '_agent-run']);
  });

  it('resolves a bun virtual entry to the physical executable, never spawns the $bunfs path', () => {
    const { command, args } = getCliLaunch(['secrets', '_agent-run'], '/$bunfs/root/agents');
    // process.execPath (the real bun/node binary) — never the un-exec-able bunfs path.
    expect(command).toBe(process.execPath);
    expect(command.includes('$bunfs')).toBe(false);
    expect(args).toEqual(['secrets', '_agent-run']);
    expect(args.some((a) => a.includes('$bunfs'))).toBe(false);
  });

  it('does not mutate the caller-supplied sub array', () => {
    const sub = ['secrets', '_agent-run'];
    getCliLaunch(sub, '/opt/agents/dist/index.js');
    expect(sub).toEqual(['secrets', '_agent-run']);
  });
});

describe('isNodeScriptEntry', () => {
  it('treats .js/.cjs/.mjs entries as node scripts', () => {
    expect(isNodeScriptEntry('/x/index.js')).toBe(true);
    expect(isNodeScriptEntry('/x/index.cjs')).toBe(true);
    expect(isNodeScriptEntry('/x/index.mjs')).toBe(true);
  });

  it('treats a non-existent extensionless path as a direct binary (no node wrapper)', () => {
    expect(isNodeScriptEntry('/nonexistent/bin/agents')).toBe(false);
  });
});
