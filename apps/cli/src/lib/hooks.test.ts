/**
 * Tests for checkVersionHookWiring — the settings.json wiring inspector behind
 * `agents doctor`. The blind spot it closes: a hook FILE can be present in a
 * version home and byte-identical to source (doctor calls it "ok"), yet be
 * absent from settings.json's event array, so it never fires. These assert the
 * inspector catches that (UNWIRED), agrees with the real registrar when wiring
 * is intact, and flags a missing settings.json.
 *
 * Runs the inspector in a subprocess with HOME=testHome because the path
 * constants in state.ts capture HOME at module-load (see doctor-diff.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testHome: string;
let userDir: string;
let systemDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-wiring-test-'));
  userDir = path.join(testHome, '.agents');
  systemDir = path.join(userDir, '.system');
  fs.mkdirSync(systemDir, { recursive: true });
  // A concrete agents.yaml keeps the migrator from firing on a missing legacy
  // state (mirrors doctor-diff.test.ts).
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

interface WiringReport {
  supported: boolean;
  settingsPath?: string;
  expected?: number;
  settingsMissing?: boolean;
  settingsUnparseable?: boolean;
  unwired: Array<{ name: string; event: string; command: string }>;
}

/** Seed a system-layer hook manifest + a version-home hooks dir carrying the
 *  hook script, so the inspector resolves a command it expects to be wired. */
function seedClaudeVersionWithHook(version: string, hookName: string, event: string): string {
  fs.writeFileSync(
    path.join(systemDir, 'agents.yaml'),
    `hooks:\n  ${hookName}:\n    script: ${hookName}.sh\n    events: [${event}]\n`,
  );
  const home = path.join(userDir, '.history', 'versions', 'claude', version, 'home');
  const hooksDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, `${hookName}.sh`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return home;
}

/** Run checkVersionHookWiring (optionally after registerHooksToSettings) in a
 *  subprocess rooted at testHome, returning its JSON report. */
function runWiring(agent: string, version: string, opts: { register?: boolean } = {}): WiringReport {
  const modulePath = path.resolve(process.cwd(), 'src/lib/hooks.ts');
  const versionsPath = path.resolve(process.cwd(), 'src/lib/versions.ts');
  const register = opts.register
    ? `
      const { getVersionHomePath } = await import(${JSON.stringify(versionsPath)});
      const { registerHooksToSettings } = mod;
      registerHooksToSettings(${JSON.stringify(agent)}, getVersionHomePath(${JSON.stringify(agent)}, ${JSON.stringify(version)}));
    `
    : '';
  const script = `
    const mod = await import(${JSON.stringify(modulePath)});
    ${register}
    const r = mod.checkVersionHookWiring(${JSON.stringify(agent)}, ${JSON.stringify(version)});
    console.log(JSON.stringify(r));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

describe('checkVersionHookWiring', () => {
  it('flags a hook present on disk but absent from settings.json as UNWIRED (the bug)', () => {
    seedClaudeVersionWithHook('2.0.0', 'demo-guard', 'PreToolUse');
    // settings.json exists but does NOT reference the hook — exactly the
    // yosemite-s1 case (file byte-identical to source, never wired).
    const configDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'home', '.claude');
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));

    const report = runWiring('claude', '2.0.0');
    expect(report.supported).toBe(true);
    expect(report.settingsMissing).toBeFalsy();
    expect(report.unwired).toHaveLength(1);
    expect(report.unwired[0]).toMatchObject({ name: 'demo-guard', event: 'PreToolUse' });
  });

  it('reports no unwired hooks once the real registrar has wired settings.json', () => {
    seedClaudeVersionWithHook('2.0.0', 'demo-guard', 'PreToolUse');
    // Let registerHooksToSettings (the same call `agents sync` makes) write the
    // wiring, then verify the inspector agrees the hook is wired.
    const report = runWiring('claude', '2.0.0', { register: true });
    expect(report.supported).toBe(true);
    expect(report.unwired).toHaveLength(0);
  });

  it('surfaces a missing settings.json when hooks are declared', () => {
    seedClaudeVersionWithHook('2.0.0', 'demo-guard', 'PreToolUse');
    // No settings.json written at all.
    const report = runWiring('claude', '2.0.0');
    expect(report.supported).toBe(true);
    expect(report.settingsMissing).toBe(true);
    expect(report.expected).toBe(1);
  });

  it('reports unsupported for an agent outside the settings.json family (codex)', () => {
    // codex hooks live in config.toml with a different schema — the inspector
    // must not claim to verify it (no false "wired").
    fs.mkdirSync(path.join(userDir, '.history', 'versions', 'codex', '0.130.0', 'home', '.codex'), { recursive: true });
    const report = runWiring('codex', '0.130.0');
    expect(report.supported).toBe(false);
    expect(report.unwired).toEqual([]);
  });
});
