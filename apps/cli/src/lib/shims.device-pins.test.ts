import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateShimScript } from './shims.js';

// Replicate machineId()/normalizeHost() so the fixture writes the device folder
// the shim will actually read.
function deviceId(): string {
  const raw = process.env.AGENTS_SYNC_MACHINE_ID || os.hostname();
  return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devpin-test-'));
}

describe('shim resolves the PER-DEVICE default pin', () => {
  test('generated shim reads devices/<machine>/agents.yaml, then central', () => {
    const script = generateShimScript('grok');
    expect(script).toContain('machine_id()');
    expect(script).toContain('devices/$(machine_id)/agents.yaml');
    // central fallback still present for pre-split installs
    expect(script).toContain('parse_agents_default "$AGENTS_USER_DIR/agents.yaml"');
  });

  // POSIX-only: the bash shim mechanism doesn't apply on Windows (which uses
  // .cmd shims), and the CI runner has no `bash`.
  test.skipIf(process.platform === 'win32')('runs the device-pinned version WITHOUT the "no default set" prompt', () => {
    const work = tmp();
    const userDir = path.join(work, '.agents');
    const mid = deviceId();

    // Default lives ONLY in the per-device file (post-split layout) ...
    fs.mkdirSync(path.join(userDir, 'devices', mid), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'devices', mid, 'agents.yaml'), 'agents:\n  grok: 0.2.32\n');
    // ... and the central agents.yaml has NO agents: section, like the real machine.
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'hooks: {}\n');
    fs.mkdirSync(path.join(userDir, '.history', 'versions', 'grok', '0.2.32', 'home', '.grok'), { recursive: true });

    // grok resolves its binary from ~/.grok/downloads; provide a fake one.
    const grokDl = path.join(work, '.grok', 'downloads');
    fs.mkdirSync(grokDl, { recursive: true });
    const fakeGrok = path.join(grokDl, 'grok-0.2.32');
    fs.writeFileSync(fakeGrok, '#!/bin/bash\necho DEVICE_PINNED_GROK_RAN\n');
    fs.chmodSync(fakeGrok, 0o755);

    // Materialize the shim; neutralize the baked AGENTS_BIN so the entrypoint
    // guard passes without a real dist build.
    const shimPath = path.join(work, 'grok');
    const script = generateShimScript('grok').replace(/^AGENTS_BIN=.*$/m, "AGENTS_BIN='/usr/bin/true'");
    fs.writeFileSync(shimPath, script);
    fs.chmodSync(shimPath, 0o755);

    const out = execFileSync('bash', [shimPath, '--hi'], {
      env: { ...process.env, AGENTS_USER_DIR: userDir, HOME: work, PATH: '/usr/bin:/bin' },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // The device pin resolved → grok ran; the "no default set" branch never fired.
    expect(out).toContain('DEVICE_PINNED_GROK_RAN');
    expect(out).not.toContain('no default set');
  });
});
