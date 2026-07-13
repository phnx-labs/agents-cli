import { describe, expect, it } from 'vitest';
import { decodePowershell } from './hosts/remote-cmd.js';
import { remoteAgentsJsonCommand } from './remote-agents-json.js';

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
