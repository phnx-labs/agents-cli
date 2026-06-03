/**
 * Tests for promptAgentVersionSelection's non-interactive behavior.
 *
 * The prompt path is interactive-only; previously, non-TTY callers were
 * silently routed into the auto-pick path. That hid scripted misuse (no
 * --agents, no --yes, piped stdin) behind a "default version" pick that
 * users couldn't predict from the docs.
 *
 * After PR 3 (matches @all syntax), non-TTY + !skipPrompts must throw
 * with a message that points at --agents claude@all / all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let VERSIONS_DIR: string;
const defaultByAgent: Record<string, string | null> = {};

vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    getVersionsDir: () => VERSIONS_DIR,
    getGlobalDefault: (agent: string) => defaultByAgent[agent] ?? null,
  };
});

async function loadPrompt() {
  const mod = await import('../versions.js');
  return mod.promptAgentVersionSelection;
}

function makeFakeInstall(agent: string, version: string): void {
  const binDir = path.join(VERSIONS_DIR, agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const cli = agent === 'claude' ? 'claude' : agent;
  fs.writeFileSync(path.join(binDir, cli), '#!/bin/sh\n');
  fs.chmodSync(path.join(binDir, cli), 0o755);
}

describe('promptAgentVersionSelection — non-interactive guards', () => {
  let savedStdinTty: boolean | undefined;
  let savedStdoutTty: boolean | undefined;

  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-nontty-'));
    VERSIONS_DIR = path.join(TEST_ROOT, 'versions');
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    for (const k of Object.keys(defaultByAgent)) delete defaultByAgent[k];
    savedStdinTty = process.stdin.isTTY;
    savedStdoutTty = process.stdout.isTTY;
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: savedStdinTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutTty, configurable: true });
    vi.resetModules();
  });

  it('throws a clear error when stdin is not a TTY and skipPrompts is not set', async () => {
    makeFakeInstall('claude', '2.1.141');
    defaultByAgent.claude = '2.1.141';

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const prompt = await loadPrompt();
    await expect(prompt(['claude'])).rejects.toThrow(/Non-interactive shell/);
    await expect(prompt(['claude'])).rejects.toThrow(/--agents claude@all/);
    await expect(prompt(['claude'])).rejects.toThrow(/--yes/);
  });

  it('does not throw on non-TTY when skipPrompts is true (script with --yes)', async () => {
    makeFakeInstall('claude', '2.1.141');

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const prompt = await loadPrompt();
    // The exact version picked depends on global meta state we don't mock
    // here. What this test guarantees is that skipPrompts: true bypasses
    // the non-TTY throw and returns claude in the agent set.
    const result = await prompt(['claude'], { skipPrompts: true });

    expect(result.selectedAgents).toEqual(['claude']);
    expect(result.versionSelections.size).toBeGreaterThan(0);
  });

  it('returns empty selections when no capable agents are installed', async () => {
    // No installs at all — both interactive and non-interactive paths short-
    // circuit before hitting the TTY check.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const prompt = await loadPrompt();
    const result = await prompt(['claude']);

    expect(result.selectedAgents).toEqual([]);
    expect(result.versionSelections.size).toBe(0);
  });
});
