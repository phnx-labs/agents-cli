import { describe, it, expect } from 'vitest';
import { BUILT_IN_AGENTS } from './agents';
import {
  buildNewAgentLaunchCommand,
  harnessLaunchRegistrations,
  resolveLaunchTarget,
  launchOptsForTarget,
  launchOptsForHarnessCommand,
  DEFAULT_LAUNCH_TARGET,
} from './launchTarget';

describe('resolveLaunchTarget', () => {
  it('defaults to auto when unset', () => {
    expect(resolveLaunchTarget(undefined)).toBe('auto');
    expect(DEFAULT_LAUNCH_TARGET).toBe('auto');
  });

  it('accepts the three configured values', () => {
    expect(resolveLaunchTarget('auto')).toBe('auto');
    expect(resolveLaunchTarget('local')).toBe('local');
    expect(resolveLaunchTarget('ask')).toBe('ask');
  });

  it('falls back to the default on an unrecognized value instead of failing the launch', () => {
    expect(resolveLaunchTarget('worker')).toBe('auto');
    expect(resolveLaunchTarget(42)).toBe('auto');
    expect(resolveLaunchTarget(null)).toBe('auto');
  });
});

describe('launchOptsForTarget', () => {
  it('auto sets neither flag, so the launch emits --device auto', () => {
    expect(launchOptsForTarget('auto')).toEqual({});
  });

  it('local pins this machine', () => {
    expect(launchOptsForTarget('local')).toEqual({ local: true });
  });

  it('ask prompts for the host', () => {
    expect(launchOptsForTarget('ask')).toEqual({ pickHost: true });
  });
});

describe('launchOptsForHarnessCommand', () => {
  it('default auto-picks the device and the account, with no prompt on either', () => {
    expect(launchOptsForHarnessCommand('default', 'auto')).toEqual({});
  });

  it('preserves explicit local or ask placement and never adds an account prompt', () => {
    expect(launchOptsForHarnessCommand('default', 'local')).toEqual({ local: true });
    expect(launchOptsForHarnessCommand('default', 'ask')).toEqual({ pickHost: true });
  });

  it('Pick Host asks for both layers while Auto asks for neither', () => {
    expect(launchOptsForHarnessCommand('pick-host')).toEqual({ pickHost: true, accountPicker: true });
    expect(launchOptsForHarnessCommand('auto')).toEqual({});
  });
});

describe('registered harness launch commands', () => {
  const RUNNERS = BUILT_IN_AGENTS.filter(({ key }) => key !== 'shell' && key !== 'gemini');

  it('registers the default, Pick Host, and Auto command ids for every active harness', () => {
    for (const agent of RUNNERS) {
      expect(harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto').map((entry) => ({
        commandId: entry.commandId,
        variant: entry.variant,
      }))).toEqual([
        { commandId: agent.commandId, variant: 'default' },
        { commandId: `${agent.commandId}PickHost`, variant: 'pick-host' },
        { commandId: `${agent.commandId}Auto`, variant: 'auto' },
      ]);
    }
  });

  it('reads the configured default target when the command is invoked', () => {
    let target: 'auto' | 'local' = 'auto';
    const [registration] = harnessLaunchRegistrations('claude', 'agents.newClaude', () => target);
    expect(registration.launchOptions()).toEqual({ agentKey: 'claude' });
    target = 'local';
    expect(registration.launchOptions()).toEqual({ agentKey: 'claude', local: true });
  });

  it('builds each active harness default as automatic device and balanced account, with no picker', () => {
    for (const agent of RUNNERS) {
      const [registration] = harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto');
      const command = buildNewAgentLaunchCommand(registration.launchOptions());
      expect(command).toBe(
        `agents run ${agent.key} --interactive --device auto --strategy balanced --mode auto`,
      );
      // The trailing `@` is what makes agents-cli stop and prompt. RUSH-3057:
      // the everyday launch command must never carry it.
      expect(command).not.toContain(`${agent.key}@`);
    }
  });

  it('builds each Pick Host command as an explicit device followed by the account picker', () => {
    for (const agent of RUNNERS) {
      const [, registration] = harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto');
      expect(buildNewAgentLaunchCommand({
        ...registration.launchOptions(),
        host: 'worker-box',
      })).toBe(`agents run ${agent.key}@ --interactive --device 'worker-box' --mode auto`);
    }
  });

  it('builds each Auto command with automatic device and balanced account selection', () => {
    for (const agent of RUNNERS) {
      const [, , registration] = harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto');
      expect(buildNewAgentLaunchCommand(registration.launchOptions())).toBe(
        `agents run ${agent.key} --interactive --device auto --strategy balanced --mode auto`,
      );
    }
  });

  it('keeps configured local and prompted-device defaults on the balanced path', () => {
    const [local] = harnessLaunchRegistrations('claude', 'agents.newClaude', () => 'local');
    expect(buildNewAgentLaunchCommand(local.launchOptions())).toBe(
      'agents run claude --interactive --strategy balanced --mode auto',
    );

    const [ask] = harnessLaunchRegistrations('claude', 'agents.newClaude', () => 'ask');
    expect(buildNewAgentLaunchCommand({ ...ask.launchOptions(), host: 'worker-box' })).toBe(
      "agents run claude --interactive --device 'worker-box' --strategy balanced --mode auto",
    );
  });
});
