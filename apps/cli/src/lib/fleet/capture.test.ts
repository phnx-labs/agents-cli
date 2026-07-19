import { describe, it, expect } from 'vitest';
import * as yaml from 'yaml';
import { captureFleet } from './capture.js';
import type { FleetManifest } from './types.js';

describe('captureFleet', () => {
  const inputs = {
    devices: ['mac-mini', 'yosemite-s0'],
    defaults: { agents: ['claude@latest', 'codex@latest'], sync: ['user'], login: 'sync' as const },
    agentsByDevice: { 'mac-mini': ['claude@latest', 'droid@latest'] },
    secretsBundles: ['ssh-keys', 'attio'],
    routines: ['review-open-prs', 'cycle-hygiene'],
  };

  it('serializes device names + desired state (no connection details)', () => {
    const m = captureFleet(undefined, inputs);
    expect(m.devices).not.toBe('all');
    const map = m.devices as Record<string, { agents?: string[] }>;
    expect(Object.keys(map).sort()).toEqual(['mac-mini', 'yosemite-s0']);
    // per-device agents from --from-pins land on the device; the other inherits.
    expect(map['mac-mini'].agents).toEqual(['claude@latest', 'droid@latest']);
    expect(map['yosemite-s0'].agents).toBeUndefined();
    expect(m.defaults?.agents).toEqual(['claude@latest', 'codex@latest']);
    expect(m.secrets?.bundles).toEqual(['attio', 'ssh-keys']); // sorted, names only
    expect(m.routines).toEqual(['cycle-hygiene', 'review-open-prs']);
  });

  it('PRIVACY: the serialized fleet: block carries no IP, username, host, or browser endpoint', () => {
    // The live registry has addresses (100.x), users (`muqsit`), and the browser
    // block has ssh://user@host endpoints. NONE may leak into agents.yaml fleet:.
    const m = captureFleet(undefined, inputs);
    const out = yaml.stringify({ fleet: m });
    expect(out).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/); // no IPv4
    expect(out).not.toMatch(/address:/);
    expect(out).not.toMatch(/\buser:/);
    expect(out).not.toMatch(/ssh:\/\//); // no browser ssh endpoints
    // The only legit `@` is an agent version spec (`claude@latest`, `codex@1.2`).
    // Strip those, then any remaining `@` would be a leaked user@host.
    const stripped = out.replace(/@latest/g, '').replace(/@\d[\w.-]*/g, '');
    expect(stripped).not.toMatch(/@/);
  });

  it('never records a browser: block (browser syncs via the central block, not fleet:)', () => {
    const m = captureFleet(undefined, inputs);
    expect((m as Record<string, unknown>).browser).toBeUndefined();
  });

  it('is additive: a hand-authored per-device override is preserved', () => {
    const prev: FleetManifest = {
      defaults: { agents: ['claude@latest'], sync: ['user'], login: 'sync' },
      devices: { 'mac-mini': { agents: ['gemini@latest'], login: 'skip' } },
    };
    const m = captureFleet(prev, inputs);
    const map = m.devices as Record<string, { agents?: string[]; login?: string }>;
    // hand-authored agents + login on mac-mini win over the captured pins.
    expect(map['mac-mini'].agents).toEqual(['gemini@latest']);
    expect(map['mac-mini'].login).toBe('skip');
    // the newly-seen device is still added.
    expect(map['yosemite-s0']).toBeDefined();
    // hand-authored defaults are kept, not overwritten by inputs.defaults.
    expect(m.defaults?.agents).toEqual(['claude@latest']);
  });

  it('omits empty extras rather than writing empty keys', () => {
    const m = captureFleet(undefined, { devices: ['s0'], secretsBundles: [], routines: [] });
    expect(m.secrets).toBeUndefined();
    expect(m.routines).toBeUndefined();
  });
});
