import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import { rmSync } from 'fs';
import type * as net from 'net';

const TEST_HOME = `/tmp/agents-cli-browser-stream-${process.pid}`;
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

const { getHelpersDir } = await import('../state.js');
const { BrowserIPCServer } = await import('./ipc.js');
const { BrowserService } = await import('./service.js');
const { FLEET_REMOTE_ENV } = await import('./remote-control.js');
const { runBrowserIPCStream } = await import('./stream.js');
const HELPER_DIR = getHelpersDir();

let server: InstanceType<typeof BrowserIPCServer>;

beforeEach(async () => {
  server = new BrowserIPCServer(new BrowserService());
  await server.start();
});

afterEach(async () => {
  await server.stop();
  rmSync(TEST_HOME, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

function waitForLines(output: PassThrough, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      const lines = text.trim().split('\n');
      if (lines.length < count) return;
      output.off('data', onData);
      resolve(lines);
    };
    output.on('data', onData);
  });
}

describe('runBrowserIPCStream', () => {
  it('reuses one real daemon socket for successive requests', async () => {
    const nativeServer = (server as unknown as { server: net.Server }).server;
    let connectionCount = 0;
    nativeServer.on('connection', () => { connectionCount += 1; });

    const input = new PassThrough();
    const output = new PassThrough();
    const run = runBrowserIPCStream({
      input,
      output,
      actor: 'agent:test',
      autoStartDaemon: false,
    });

    const firstLine = waitForLines(output, 1);
    input.write('{"action":"version"}\n');
    const [first] = await firstLine;
    expect(JSON.parse(first)).toMatchObject({ ok: true });
    const connectionsAfterFirstRequest = connectionCount;

    const secondLine = waitForLines(output, 1);
    input.write('{"action":"version"}\n');
    const [second] = await secondLine;
    expect(JSON.parse(second)).toMatchObject({ ok: true });
    expect(connectionCount).toBe(connectionsAfterFirstRequest);

    input.end();
    await run;
  });

  it('reports malformed input and continues on the same connection', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputLines = waitForLines(output, 2);
    const run = runBrowserIPCStream({
      input,
      output,
      actor: 'agent:test',
      autoStartDaemon: false,
    });

    input.write('not-json\n');
    input.write('{"action":"version"}\n');
    input.end();

    const [errorLine, versionLine] = await outputLines;
    expect(JSON.parse(errorLine)).toMatchObject({ ok: false });
    expect(JSON.parse(versionLine)).toMatchObject({ ok: true });
    await run;
  });

  it('refuses a fleet-remote start without consent and keeps the stream open', async () => {
    vi.stubEnv(FLEET_REMOTE_ENV, '1');
    vi.stubEnv('AGENTS_ACTOR_HOST', 'yosemite-s0');
    const input = new PassThrough();
    const output = new PassThrough();
    const outputLines = waitForLines(output, 2);
    const run = runBrowserIPCStream({
      input,
      output,
      actor: 'agent:test',
      autoStartDaemon: false,
    });

    input.write('{"action":"start","profile":"local"}\n');
    input.write('{"action":"version"}\n');
    input.end();

    const [startLine, versionLine] = await outputLines;
    expect(JSON.parse(startLine)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/yosemite-s0.*browser --host.*remote-control on/s),
    });
    expect(JSON.parse(versionLine)).toMatchObject({ ok: true });
    await run;
  });
});
