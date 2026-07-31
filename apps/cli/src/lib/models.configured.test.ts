import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// resolveConfiguredModel walks: run-default (agents.yaml) -> the agent's native
// settings.json -> the CLI's built-in default. state/versions resolve HOME at
// import time, so we point HOME at a throwaway dir and re-import fresh per test.
let TMP: string;

async function freshModels() {
  vi.resetModules();
  return import('./models.js');
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** The agents.yaml run-default that layer 1 reads. */
function setRunDefault(model: string) {
  const yaml = `run:\n  defaults:\n    "claude:*":\n      model: ${model}\n`;
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.agents', 'agents.yaml'), yaml);
}

/** The agent's OWN native settings.json that layer 2 reads. */
function setNativeModel(version: string, model: string) {
  writeJson(
    path.join(TMP, '.agents', '.history', 'versions', 'claude', version, 'home', '.claude', 'settings.json'),
    { model },
  );
}

describe('resolveConfiguredModel precedence', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cfgmodel-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('prefers the agents.yaml run default over everything', async () => {
    setRunDefault('opus');
    setNativeModel('9.9.9', 'sonnet'); // present, but run default must win
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('claude', '9.9.9')).toEqual({ model: 'opus', source: 'run-default' });
  });

  it("falls back to the agent's native settings.json model", async () => {
    setNativeModel('9.9.9', 'sonnet'); // no run default configured
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('claude', '9.9.9')).toEqual({ model: 'sonnet', source: 'config' });
  });

  it('returns null when nothing is configured and no model catalog exists', async () => {
    // No run default, no settings.json model, and no installed binary/bundle in
    // the temp HOME -> no catalog -> nothing to report.
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('claude', '9.9.9')).toBeNull();
  });

  it('ignores a blank/malformed native model and falls through', async () => {
    writeJson(
      path.join(TMP, '.agents', '.history', 'versions', 'claude', '9.9.9', 'home', '.claude', 'settings.json'),
      { model: '   ' },
    );
    const { resolveConfiguredModel } = await freshModels();
    // blank model is not a real selection; with no catalog it resolves to null
    expect(resolveConfiguredModel('claude', '9.9.9')).toBeNull();
  });
});

describe('formatAgentIdentity', () => {
  it('joins pieces with a separator and drops empty ones', async () => {
    const { formatAgentIdentity } = await freshModels();
    // Split on the middot so the test is agnostic to chalk color codes.
    const parts = (s: string) => s.split('·').map((p) => p.trim()).filter(Boolean);
    expect(parts(formatAgentIdentity('claude@2.1.186', 'opus', 'you@rush.dev'))).toEqual([
      'claude@2.1.186',
      'opus',
      'you@rush.dev',
    ]);
    expect(parts(formatAgentIdentity('claude@2.1.186', null, 'you@rush.dev'))).toEqual([
      'claude@2.1.186',
      'you@rush.dev',
    ]);
    expect(formatAgentIdentity('solo')).toBe('solo');
    expect(formatAgentIdentity(null, undefined, '')).toBe('');
  });
});
