import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { metadataResolveForwardedArgs } from './sessions.js';
import { remoteAgentsJsonCommand } from '../lib/remote-agents-json.js';
import { NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import { repoRoot, cliEntry, tsxLoaderUrl, writeUpdateCache, runAgents } from './sessions.test-fixture.js';

interface SessionResolverSshPeer {
  target: string;
  fixture: ChildProcess;
  socket: string;
  proofFile: string;
  /** The test's temp home — every process of this test carries it in argv. */
  home: string;
}

/**
 * Temp base for the ssh-peer tests. The production ControlPath is
 * `<home>/.agents/.cache/ssh/cm-%C`, and ssh appends a ~18-char listener
 * suffix — under macOS CI's deep TMPDIR (/var/folders/<30 chars>/T/sr-XXXXXX)
 * that blows past the 104-byte sun_path limit and every peer test fails at
 * ControlMaster startup. `/tmp` resolves to /private/tmp (12 chars), keeping
 * the full socket path under the limit. Linux paths are short already.
 */
const sshPeerTmpBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir();

/** Start the real ssh2 peer and graft its ephemeral TCP listener onto the exact
 * default-port OpenSSH ControlPath the production parent will look up. */
async function startSessionResolverSshPeer(
  mode: 'old-peer' | 'malformed',
  tempHome: string,
): Promise<SessionResolverSshPeer> {
  const hostKey = path.join(tempHome, 'fixture-host-key');
  const peerHome = path.join(tempHome, 'peer-home');
  const username = `srp-${crypto.randomBytes(16).toString('hex')}`;
  const target = `${username}@127.0.0.1`;
  const proofFile = path.join(tempHome, `${mode}-proof.txt`);
  const expectedCommand = remoteAgentsJsonCommand(
    metadataResolveForwardedArgs('abcd7777', {}),
    NO_FANOUT_ENV,
  );
  const controlPathTemplate = path.join(tempHome, '.agents', '.cache', 'ssh', 'cm-%C');
  fs.mkdirSync(path.dirname(controlPathTemplate), { recursive: true, mode: 0o700 });
  writeUpdateCache(peerHome);

  const keygen = spawnSync('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-N', '', '-f', hostKey], {
    encoding: 'utf-8',
  });
  if (keygen.status !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr}`);

  const fixture = spawn(process.execPath, [path.join(repoRoot, 'src', 'commands', 'testdata', 'session-resolver-ssh-peer.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SRP_MODE: mode,
      SRP_HOST_KEY: hostKey,
      SRP_PEER_HOME: peerHome,
      SRP_USERNAME: username,
      SRP_EXPECTED_COMMAND: expectedCommand,
      SRP_PROOF_FILE: proofFile,
      SRP_OLD_VERSION: '1.20.88',
      SRP_TSX_LOADER: tsxLoaderUrl,
      SRP_CLI_ENTRY: cliEntry,
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let output = '';
    const fail = (error: Error) => reject(new Error(`ssh2 fixture did not start: ${error.message}; ${output}`));
    fixture.once('error', fail);
    fixture.stderr?.on('data', (data) => { output += data.toString(); });
    fixture.stdout?.on('data', (data) => {
      output += data.toString();
      const match = output.match(/PORT=(\d+)/);
      if (match) resolve(match[1]);
    });
    fixture.once('exit', (code) => fail(new Error(`exited ${code ?? 'without a code'}`)));
  });

  // `ssh -G` expands `%C` exactly as the real parent will, including its
  // default port 22. Do not use ~/.ssh/config: HOME is deliberately isolated.
  const expanded = spawnSync('ssh', [
    '-G',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPathTemplate}`,
    '-o', 'ControlPersist=60s',
    target,
  ], { encoding: 'utf-8' });
  if (expanded.status !== 0) throw new Error(`ssh -G failed: ${expanded.stderr}`);
  const socket = expanded.stdout.match(/^controlpath\s+(.+)$/m)?.[1];
  if (!socket) throw new Error(`ssh -G did not emit a controlpath: ${expanded.stdout}`);

  // The only TCP connection goes to the fixture's ephemeral port. `-S` forces
  // that master to listen at the port-22 path production's unmodified ssh call
  // will reuse below.
  const master = spawnSync('ssh', [
    '-F', '/dev/null', '-f', '-M', '-N', '-p', port, '-S', socket,
    '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ControlPersist=60s', target,
  ], { encoding: 'utf-8', timeout: 10_000 });
  if (master.status !== 0) throw new Error(`ssh ControlMaster failed: ${master.stderr}`);
  return { target, fixture, socket, proofFile, home: tempHome };
}

async function stopSessionResolverSshPeer(peer: SessionResolverSshPeer): Promise<void> {
  spawnSync('ssh', ['-F', '/dev/null', '-S', peer.socket, '-O', 'exit', peer.target], {
    encoding: 'utf-8', timeout: 10_000,
  });
  if (!peer.fixture.killed) peer.fixture.kill('SIGTERM');
  await new Promise<void>((resolve) => peer.fixture.once('exit', () => resolve()));
  // The peer side lingers past fixture death: the peer CLI that answered over
  // ssh (still flushing its index into peer-home/.agents) and the parent's own
  // ControlPersist master. Both keep writing into the temp home, which raced
  // the cleanup rmdir ENOTEMPTY on CI even with rm retries. Every one of those
  // processes carries this test's unique temp path in argv, so a path-scoped
  // pkill reaps exactly them and nothing else.
  spawnSync('pkill', ['-f', peer.home]);
}

/**
 * rm -rf the peer test's temp home, tolerating the trailing writes the peer
 * side (the peer CLI answering over ssh, plus the ControlPersist master
 * winding down) races into it after stop — a bare rmSync intermittently
 * dies ENOTEMPTY on CI. Retries absorb exactly that window.
 *
 * Two hardenings after 8 x 250ms still lost the race on a loaded runner
 * (`ENOTEMPTY: rmdir '/tmp/sr-46716N/peer-home'`, which failed PRs whose diff
 * never touched sessions at all):
 *
 *  - The window is now 20 x 500ms. `stopSessionResolverSshPeer` awaits the ssh
 *    exit, but the ControlPersist master and the peer CLI are separate
 *    processes that can outlive it, so the tail is bounded by process teardown,
 *    not by anything this test controls.
 *  - Cleanup is best-effort. Every assertion has already run by the time this
 *    is reached in `finally`; a leaked directory under TMPDIR on an ephemeral
 *    runner is not a test failure, and turning one into a red shard hides which
 *    PRs are actually broken. The failure is still reported on stderr rather
 *    than swallowed, so a genuine leak stays visible in the CI log.
 */
function rmTempHomeWithRetries(tempHome: string): void {
  try {
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (err) {
    console.warn(`[sessions.ssh-peer.test] temp home cleanup did not complete for ${tempHome}: ${(err as Error).message}`);
  }
}

describe('agents sessions --resolve against a real ssh peer', () => {
  // POSIX-only (RUSH-2215): grafts a real ssh2 peer onto an OpenSSH
  // `ControlMaster=auto` multiplexing socket, which Windows OpenSSH does not
  // support — the ControlMaster startup hangs the fixture (and the suite) rather
  // than failing fast, so this real-peer path only runs on a POSIX host.
  it.skipIf(process.platform === 'win32')('returns a partial fleet result when an old peer rejects the safe resolver protocol', async () => {
    const tempHome = fs.mkdtempSync(path.join(sshPeerTmpBase, 'sr-'));
    let peer: SessionResolverSshPeer | undefined;
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work');
      fs.mkdirSync(repoDir, { recursive: true });
      peer = await startSessionResolverSshPeer('old-peer', tempHome);

      const result = runAgents(
        ['sessions', '--resolve', 'abcd7777', '--json', '--device', peer.target],
        repoDir,
        tempHome,
      );
      // RUSH-2492: an incomplete peer sweep degrades to a warning + exit 1
      // instead of the old hard-abort exit 2 (SES-IF-2a, amended 2026-08-10).
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(peer.target);
      expect(result.stderr).toContain('unreachable, not checked');
      expect(fs.readFileSync(peer.proofFile, 'utf-8')).toBe(
        "1.20.88:unknown option '--resolve-safe-v1'\n",
      );
    } finally {
      if (peer) await stopSessionResolverSshPeer(peer);
      rmTempHomeWithRetries(tempHome);
    }
  }, 90_000);

  // POSIX-only (RUSH-2215): same real ssh2 peer over an OpenSSH ControlMaster
  // multiplexing socket as the sibling test above — hangs on Windows OpenSSH.
  it.skipIf(process.platform === 'win32')('returns a partial fleet result when a real exit-zero peer emits malformed safe output', async () => {
    const tempHome = fs.mkdtempSync(path.join(sshPeerTmpBase, 'sr-'));
    let peer: SessionResolverSshPeer | undefined;
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work');
      fs.mkdirSync(repoDir, { recursive: true });
      peer = await startSessionResolverSshPeer('malformed', tempHome);

      const result = runAgents(
        ['sessions', '--resolve', 'abcd7777', '--json', '--device', peer.target],
        repoDir,
        tempHome,
      );
      // RUSH-2492: an incomplete peer sweep degrades to a warning + exit 1
      // instead of the old hard-abort exit 2 (SES-IF-2a, amended 2026-08-10).
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(peer.target);
      expect(result.stderr).toContain('unreachable, not checked');
    } finally {
      if (peer) await stopSessionResolverSshPeer(peer);
      rmTempHomeWithRetries(tempHome);
    }
  });
});
