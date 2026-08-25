import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserProfileWithDeclarations } from './profiles.js';

/**
 * `identityLoopbackMismatch` reads the live device registry (kind + declaring
 * devices) and this machine's id. Redirect HOME and the machine id, then
 * re-import so `state.ts` binds the temp user repo — the same store redirect
 * as `registry.test.ts` and `profiles.test.ts`.
 */

let root: string;
let previousHome: string | undefined;
let previousMachine: string | undefined;

function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(value));
}

function deviceFile(device: string): string {
  return path.join(root, '.agents', 'devices', device, 'agents.yaml');
}

function profile(
  name: string,
  devices: string[],
  endpoints: string[],
): BrowserProfileWithDeclarations {
  return {
    name,
    browser: 'comet',
    endpoints,
    devices,
  };
}

async function loadMismatch(): Promise<
  typeof import('./runtime-state.js')['identityLoopbackMismatch']
> {
  vi.resetModules();
  const mod = await import('./runtime-state.js');
  return mod.identityLoopbackMismatch;
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousMachine = process.env.AGENTS_SYNC_MACHINE_ID;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-identity-'));
  process.env.HOME = root;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousMachine === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
  else process.env.AGENTS_SYNC_MACHINE_ID = previousMachine;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe('identityLoopbackMismatch', () => {
  it('fires when an identity-bearing name is loopback on a box that is not the declaring device', async () => {
    writeYaml(deviceFile('zion'), {
      browser: {
        'comet-local': { browser: 'comet', endpoints: ['cdp://localhost:9333'] },
      },
    });
    const identityLoopbackMismatch = await loadMismatch();
    const result = identityLoopbackMismatch(
      profile('comet-local', ['zion'], ['cdp://localhost:9333']),
    );
    expect(result.misfiled).toBe(true);
    if (!result.misfiled) throw new Error('expected misfiled');
    expect(result.why).toContain('zion');
    expect(result.why).toContain('testbox');
    expect(result.why).toContain('cdp://localhost:9333');
    expect(result.why).toMatch(/identity-bearing/);
  });

  it('fires for 127.0.0.1 and ::1 the same way as localhost', async () => {
    writeYaml(deviceFile('zion'), {
      browser: {
        v4: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] },
        v6: { browser: 'chrome', endpoints: ['cdp://[::1]:9222'] },
      },
    });
    const identityLoopbackMismatch = await loadMismatch();
    expect(
      identityLoopbackMismatch(profile('v4', ['zion'], ['cdp://127.0.0.1:9222'])).misfiled,
    ).toBe(true);
    expect(
      identityLoopbackMismatch(profile('v6', ['zion'], ['cdp://[::1]:9222'])).misfiled,
    ).toBe(true);
  });

  it('passes when this machine is the declaring device', async () => {
    writeYaml(deviceFile('testbox'), {
      browser: {
        'comet-local': { browser: 'comet', endpoints: ['cdp://localhost:9333'] },
      },
    });
    const identityLoopbackMismatch = await loadMismatch();
    expect(
      identityLoopbackMismatch(
        profile('comet-local', ['testbox'], ['cdp://localhost:9333']),
      ).misfiled,
    ).toBe(false);
  });

  it('passes when several devices declare the name (fungible)', async () => {
    const config = { browser: 'chrome', endpoints: ['cdp://localhost:9222'] };
    writeYaml(deviceFile('zion'), { browser: { scratch: config } });
    writeYaml(deviceFile('testbox'), { browser: { scratch: config } });
    writeYaml(deviceFile('s0'), { browser: { scratch: config } });
    const identityLoopbackMismatch = await loadMismatch();
    expect(
      identityLoopbackMismatch(
        profile('scratch', ['zion', 'testbox', 's0'], ['cdp://localhost:9222']),
      ).misfiled,
    ).toBe(false);
  });

  it('passes when the endpoint already names a host (ssh://)', async () => {
    writeYaml(deviceFile('mac-mini'), {
      browser: {
        'rush-app': { browser: 'custom', endpoints: ['ssh://mac-mini?port=9300'] },
      },
    });
    const identityLoopbackMismatch = await loadMismatch();
    expect(
      identityLoopbackMismatch(
        profile('rush-app', ['mac-mini'], ['ssh://mac-mini?port=9300']),
      ).misfiled,
    ).toBe(false);
  });

  it('passes when nobody declares the name', async () => {
    const identityLoopbackMismatch = await loadMismatch();
    expect(
      identityLoopbackMismatch(
        profile('absent', ['zion'], ['cdp://localhost:9333']),
      ).misfiled,
    ).toBe(false);
  });
});
