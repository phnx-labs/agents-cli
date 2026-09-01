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

describe('agents notify routes owner sends through the feed composer (PHNX-3698)', () => {
  const SESSION = 'a1b2c3d4-1111-4222-8333-444455556666';
  const saved: Record<string, string | undefined> = {};
  const stdout: string[] = [];
  let originalLog: typeof console.log;
  let originalErr: typeof console.error;

  function stash(key: string, value: string | undefined) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(async () => {
    stdout.length = 0;
    originalLog = console.log;
    originalErr = console.error;
    console.log = (...args: unknown[]) => {
      stdout.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    console.error = () => {}; // swallow the deprecation notice
    const { _resetLinearWorkspaceCache } = await import('../lib/session/linear.js');
    _resetLinearWorkspaceCache();
    stash('LINEAR_WORKSPACE', 'getrush');
    // AGENT_SESSION_ID is checked first and is set by the real run this suite
    // executes inside — pin both to the fixture and clear the other signals so
    // resolvePostIdentity resolves OUR session, not the live one.
    stash('AGENT_SESSION_ID', SESSION);
    stash('AGENTS_SESSION_ID', SESSION);
    stash('AGENTS_MAILBOX_DIR', undefined);
    stash('AGENT_LAUNCH_ID', undefined);
    stash('AGENTS_AGENT_NAME', 'claude');
    stash('AGENTS_MACHINE_ID', 'zion');

    // Owner config so the dry-run resolves a destination (no delivery on dry-run).
    const home = process.env.HOME ?? os.homedir();
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'notify:\n  owner:\n    channel: desktop\n    to: local\n');
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const { _resetLinearWorkspaceCache } = await import('../lib/session/linear.js');
    _resetLinearWorkspaceCache();
  });

  it('--dry-run --json shows the composed message as a plain owner sentence with no dumped URLs', async () => {
    const program = new Command();
    registerSendCommand(program);

    await program.parseAsync([
      'node', 'agents', 'notify',
      '--text', 'Deploy never ran. PHNX-3689 is the root cause.',
      '--dry-run', '--json',
    ]);

    const line = stdout.find((l) => l.trim().startsWith('{'));
    expect(line, 'expected a JSON payload on stdout').toBeTruthy();
    const payload = JSON.parse(line!);
    expect(payload.dryRun).toBe(true);
    // The composer ran: raw body is short-shaped with a "Sent from" footer. The
    // owner transport (iMessage/rush) can't render a labeled link, so the key
    // stays plain text and NO URL is dumped (PHNX-3698 — labeled links are a
    // Slack-sink-only behavior).
    expect(payload.text).toContain('PHNX-3689 is the root cause.');
    expect(payload.text).toContain('Sent from claude/');
    expect(payload.text).not.toContain('https://linear.app/getrush/issue/PHNX-3689');
    expect(payload.text).not.toContain(`https://prix.dev/console/sessions/${SESSION}`);
    expect(payload.text).not.toContain('http');
  });
});
