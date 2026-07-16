import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFleetManifest, readFleetFile, resolveDesired } from './manifest.js';

describe('parseFleetManifest', () => {
  it('accepts defaults + devices: all', () => {
    const m = parseFleetManifest({
      defaults: { agents: ['claude@latest', 'codex@latest'], sync: ['user'], login: 'sync' },
      devices: 'all',
    });
    expect(m.devices).toBe('all');
    expect(m.defaults?.agents).toEqual(['claude@latest', 'codex@latest']);
    expect(m.defaults?.login).toBe('sync');
  });

  it('accepts an explicit device map with an empty (inherit) entry', () => {
    const m = parseFleetManifest({
      defaults: { agents: ['claude@latest'] },
      devices: { 'yosemite-s1': {}, 'mac-mini': { agents: ['codex@latest'] } },
    });
    expect(m.devices).not.toBe('all');
    const map = m.devices as Record<string, unknown>;
    expect(Object.keys(map)).toEqual(['yosemite-s1', 'mac-mini']);
  });

  it('rejects a missing devices key', () => {
    expect(() => parseFleetManifest({ defaults: {} })).toThrow(/devices/);
  });

  it('rejects an invalid login mode', () => {
    expect(() => parseFleetManifest({ defaults: { login: 'always' }, devices: 'all' })).toThrow(/login/);
  });

  it('rejects non-string agents list', () => {
    expect(() => parseFleetManifest({ defaults: { agents: [1, 2] }, devices: 'all' })).toThrow(/agents/);
  });

  it('rejects a non-mapping fleet block', () => {
    expect(() => parseFleetManifest(['a', 'b'])).toThrow();
    expect(() => parseFleetManifest('all')).toThrow();
  });
});

describe('readFleetFile', () => {
  it('extracts + validates the fleet: block from a YAML file, ignoring other keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mf-'));
    const file = path.join(dir, 'agents.yaml');
    fs.writeFileSync(
      file,
      [
        'agents:',
        '  claude: latest',
        'fleet:',
        '  defaults:',
        '    agents: [claude@latest, codex@latest]',
        '    login: sync',
        '  devices: all',
        '',
      ].join('\n'),
    );
    const m = readFleetFile(file);
    expect(m.devices).toBe('all');
    expect(m.defaults?.agents).toEqual(['claude@latest', 'codex@latest']);
  });

  it('errors clearly when the file has no fleet: block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mf-'));
    const file = path.join(dir, 'agents.yaml');
    fs.writeFileSync(file, 'agents:\n  claude: latest\n');
    expect(() => readFleetFile(file)).toThrow(/no fleet: block/);
  });

  it('errors on a missing file', () => {
    expect(() => readFleetFile('/nonexistent/agents.yaml')).toThrow(/not found/);
  });
});

describe('resolveDesired', () => {
  const ctx = { onlineDevices: ['s0', 's1', 'mac'], registeredDevices: ['s0', 's1', 'mac'], source: 's0' };

  it('expands devices: all to every online device minus the source', () => {
    const m = parseFleetManifest({ defaults: { agents: ['claude@latest'], sync: ['user'] }, devices: 'all' });
    const out = resolveDesired(m, ctx);
    expect(out.map((d) => d.device)).toEqual(['s1', 'mac']);
    expect(out.every((d) => d.agents[0] === 'claude@latest')).toBe(true);
    expect(out.every((d) => d.login === 'sync')).toBe(true); // default
  });

  it('merges per-device overrides over defaults', () => {
    const m = parseFleetManifest({
      defaults: { agents: ['claude@latest'], sync: ['user'], login: 'sync' },
      devices: { s1: {}, mac: { agents: ['codex@latest'], login: 'skip' } },
    });
    const out = resolveDesired(m, ctx);
    const s1 = out.find((d) => d.device === 's1')!;
    const mac = out.find((d) => d.device === 'mac')!;
    expect(s1.agents).toEqual(['claude@latest']); // inherited
    expect(mac.agents).toEqual(['codex@latest']); // overridden
    expect(mac.login).toBe('skip');
  });

  it('throws on an explicit unknown device', () => {
    const m = parseFleetManifest({ defaults: {}, devices: { 'ghost-box': {} } });
    expect(() => resolveDesired(m, ctx)).toThrow(/not a registered device/);
  });

  it('never targets the source machine', () => {
    const m = parseFleetManifest({ defaults: { agents: ['claude@latest'] }, devices: { s0: {}, s1: {} } });
    const out = resolveDesired(m, ctx);
    expect(out.map((d) => d.device)).toEqual(['s1']);
  });
});
