/**
 * `bindBrokerSocket` used to unlink and rebind a socket whose owner missed a
 * single `agentPing`. The broker is single-threaded, so a large read or the
 * startup rehydrate can outlast one 700ms ping budget while the process is
 * perfectly healthy — and the reclaim then left it alive holding every unlocked
 * bundle in RAM that no client could reach. Observed on a real machine after an
 * install into a second npm prefix: two brokers, one socket path, two kernel
 * sockets (lsof), one of them orphaned.
 *
 * brokerPidAlive is the second, independent liveness signal that makes the
 * reclaim safe. These drive a REAL owner file and REAL processes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { brokerPidAlive } from './agent.js';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-pid-'));
  prev = process.env.AGENTS_SECRETS_AGENT_DIR;
  process.env.AGENTS_SECRETS_AGENT_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENTS_SECRETS_AGENT_DIR;
  else process.env.AGENTS_SECRETS_AGENT_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('brokerPidAlive — do not steal a live broker socket', () => {
  it('is false when no owner file exists', () => {
    expect(brokerPidAlive()).toBe(false);
  });

  it('is false for a stale pid whose process is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    fs.writeFileSync(path.join(dir, 'agent.owner'), String(pid));
    expect(brokerPidAlive()).toBe(false); // reclaim is safe
  });

  it('is TRUE for a live owner, so the socket is not reclaimed', async () => {
    const child = spawn(process.execPath, ['-e', "console.log('up'); setTimeout(() => {}, 30000)"], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    fs.writeFileSync(path.join(dir, 'agent.owner'), String(child.pid!));
    try {
      expect(brokerPidAlive()).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('ignores our own pid — a broker never blocks itself', () => {
    fs.writeFileSync(path.join(dir, 'agent.owner'), String(process.pid));
    expect(brokerPidAlive()).toBe(false);
  });
});
