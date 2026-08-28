import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { registerSendCommand } from './send.js';

describe('agents notify deprecation (PHNX-3323)', () => {
  let tmp: string;
  const saved = {
    path: process.env.PATH,
    humans: process.env.AGENTS_HUMANS_FILE,
  };
  const capturedStderr: string[] = [];
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'send-test-'));
    capturedStderr.length = 0;
    originalConsoleError = console.error;

    // Capture the deprecation notice without mutating the code under test.
    console.error = (...args: unknown[]) => {
      capturedStderr.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
      originalConsoleError(...args);
    };

    // vitest's fork-level setup.ts pins HOME to a private sandbox before imports.
    // Write our fixture agents.yaml / humans.yaml into that sandbox so state.ts
    // reads them through the same HOME it captured at module load.
    const home = process.env.HOME ?? os.homedir();
    const agentsDir = path.join(home, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'agents.yaml'),
      'notify:\n  transports:\n    telegram: openclaw-telegram\n',
    );

    // humans.yaml is the canonical owner identity; notify.owner is legacy.
    fs.writeFileSync(
      path.join(tmp, 'humans.yaml'),
      'version: 1\nowner:\n  channels:\n    - id: telegram\n      to: owner-chat-1\n  policy:\n    normal:\n      - telegram\n',
    );

    // A fake openclaw binary on PATH so the real provider exec path succeeds.
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const openclaw = path.join(binDir, 'openclaw');
    fs.writeFileSync(openclaw, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(openclaw, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml');
  });

  afterEach(() => {
    console.error = originalConsoleError;
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    if (saved.humans === undefined) delete process.env.AGENTS_HUMANS_FILE;
    else process.env.AGENTS_HUMANS_FILE = saved.humans;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('help names the deprecation and the replacement', () => {
    const program = new Command();
    registerSendCommand(program);
    const notify = program.commands.find((c) => c.name() === 'notify');
    const help = notify?.helpInformation() ?? '';
    expect(help).toContain('[DEPRECATED]');
    expect(help).toMatch(/agents feed\s+post/);
    expect(help).toMatch(/Use "agents feed\s+post"/);
  });

  it('emits a stderr deprecation notice but still delivers (real path, no mocks)', async () => {
    const program = new Command();
    registerSendCommand(program);

    await program.parseAsync(['node', 'agents', 'notify', '--text', 'deprecation probe']);

    const stderr = capturedStderr.join(' ');
    expect(stderr).toContain('deprecated');
    expect(stderr).toContain('agents feed post');
  });
});
