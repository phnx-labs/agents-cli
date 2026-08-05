import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { decodePowershell } from './hosts/remote-cmd.js';
import {
  gatherRemoteAgentsJson,
  parseRemoteAgentsJsonPayload,
  remoteAgentsJsonCommand,
  type SshCaptureFn,
} from './remote-agents-json.js';
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

describe('gatherRemoteAgentsJson early-exit + cancellation', () => {
  // `user@fqdn` tokens resolve to distinct dialable targets with no registry and
  // no real SSH; the injected capture is the only boundary the fan-out touches.
  const FAST = 'tester@fast.example.com';
  const SLOW = 'tester@slow.example.com';

  interface Row { id: string }
  const parseRows = (stdout: string): Row[] => (stdout ? JSON.parse(stdout) as Row[] : []);

  // The SLOW peer models a slow/unreachable box: it never answers on its own —
  // only its AbortSignal firing settles it, recording that it was cancelled. If
  // the fan-out waited for it (no early-exit), the 60s timeout would hang the test.
  it('resolves on the first definitive hit and SIGTERMs the still-hanging peer', async () => {
    const aborted: string[] = [];
    const capture: SshCaptureFn = (target, _cmd, { signal }) => new Promise((resolve) => {
      if (target === FAST) { resolve({ code: 0, stdout: JSON.stringify([{ id: 'the-match' }]) }); return; }
      if (signal?.aborted) { aborted.push(target); resolve({ code: null, stdout: '' }); return; }
      signal?.addEventListener('abort', () => { aborted.push(target); resolve({ code: null, stdout: '' }); }, { once: true });
    });

    const result = await gatherRemoteAgentsJson<Row>({
      args: ['sessions', '--json'],
      noFanoutEnv: 'AGENTS_SESSIONS_LOCAL',
      hosts: [FAST, SLOW],
      quiet: true,
      timeoutMs: 60_000, // long: only the abort, never a timeout, can settle SLOW
      parse: parseRows,
      earlyExit: { isDefinitive: (item) => item.id === 'the-match' },
    }, { capture });

    expect(result.items).toEqual([{ id: 'the-match' }]);
    expect(aborted).toEqual([SLOW]);   // the hanging peer's signal fired (was cancelled)
    expect(result.skipped).toEqual([]); // a cancelled peer is NOT reported unreachable
  });

  it('without early-exit, the default all-settle waits for every peer', async () => {
    const capture: SshCaptureFn = (target) => new Promise((resolve) => {
      if (target === FAST) resolve({ code: 0, stdout: JSON.stringify([{ id: 'a' }]) });
      else setTimeout(() => resolve({ code: 0, stdout: JSON.stringify([{ id: 'b' }]) }), 25);
    });

    const result = await gatherRemoteAgentsJson<Row>({
      args: ['sessions', '--json'],
      noFanoutEnv: 'X',
      hosts: [FAST, SLOW],
      quiet: true,
      parse: parseRows,
      // no earlyExit → both peers must be collected (tool-search / program-count path)
    }, { capture });

    expect(result.items.map(r => r.id).sort()).toEqual(['a', 'b']);
  });

  it('does not early-exit when no returned item satisfies the predicate', async () => {
    const capture: SshCaptureFn = (target) => new Promise((resolve) => {
      if (target === FAST) resolve({ code: 0, stdout: JSON.stringify([{ id: 'other' }]) });
      else setTimeout(() => resolve({ code: 0, stdout: JSON.stringify([{ id: 'another' }]) }), 25);
    });

    const result = await gatherRemoteAgentsJson<Row>({
      args: ['sessions', '--json'],
      noFanoutEnv: 'X',
      hosts: [FAST, SLOW],
      quiet: true,
      parse: parseRows,
      earlyExit: { isDefinitive: (item) => item.id === 'the-match' }, // never matches
    }, { capture });

    expect(result.items.map(r => r.id).sort()).toEqual(['another', 'other']);
  });

  it('with NO earlyExit, two peers holding distinct same-label rows are BOTH collected (conflict stays visible)', async () => {
    // The regression the reviewer caught: if labels early-exited, the first peer
    // would abort the second and hide the collision. Labels do NOT pass earlyExit
    // (they are not globally unique), so both rows come back and the caller can
    // surface the conflict. Modelled as two distinct ids sharing a label.
    const capture: SshCaptureFn = (target) => new Promise((resolve) => {
      if (target === FAST) resolve({ code: 0, stdout: JSON.stringify([{ id: 'peer-a', label: 'dup' }]) });
      else setTimeout(() => resolve({ code: 0, stdout: JSON.stringify([{ id: 'peer-b', label: 'dup' }]) }), 25);
    });

    const result = await gatherRemoteAgentsJson<Row & { label: string }>({
      args: ['sessions', '--json'],
      noFanoutEnv: 'X',
      hosts: [FAST, SLOW],
      quiet: true,
      parse: (stdout) => (stdout ? JSON.parse(stdout) : []),
      // no earlyExit — a label lookup must wait for every peer
    }, { capture });

    expect(result.items.map(r => r.id).sort()).toEqual(['peer-a', 'peer-b']);
  });
});
