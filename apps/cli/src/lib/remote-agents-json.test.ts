import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { decodePowershell } from './hosts/remote-cmd.js';
import { parseRemoteAgentsJsonPayload, remoteAgentsJsonCommand } from './remote-agents-json.js';
import { parseRemoteListPayload } from './session/remote-list.js';

describe('remoteAgentsJsonCommand', () => {
  it('guards a POSIX peer against recursive fan-out', () => {
    const command = remoteAgentsJsonCommand(['feed', '--json'], 'AGENTS_FEED_LOCAL', 'linux');
    expect(command).toContain('AGENTS_FEED_LOCAL=1 agents feed --json');
    expect(command).not.toContain('--local');
  });

  it('guards a Windows peer through its PowerShell environment', () => {
    const command = remoteAgentsJsonCommand(['feed', '--json'], 'AGENTS_FEED_LOCAL', 'windows');
    const encoded = command.split(' ').at(-1)!;
    const script = decodePowershell(encoded);
    expect(script).toContain("$env:AGENTS_FEED_LOCAL = '1'");
    expect(script).toContain("& 'agents' 'feed' '--json'");
  });
});

describe('parseRemoteAgentsJsonPayload', () => {
  it('preserves a strict parse failure from a zero-exit peer', () => {
    const peer = spawnSync(process.execPath, ['--eval', "process.stdout.write('[{}]')"], { encoding: 'utf8' });
    expect(peer.status).toBe(0);

    const parsed = parseRemoteAgentsJsonPayload(
      peer.stdout,
      'peer',
      (stdout, machine) => parseRemoteListPayload(stdout, machine, true),
    );

    expect(parsed).toEqual({ items: [], parseFailed: true });
  });
});
