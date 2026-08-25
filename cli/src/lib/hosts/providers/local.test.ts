import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LocalHostProvider as LHP } from './local.js';

// state.ts captures HOME at module-load, so isolate by setting HOME to a temp
// dir and re-importing the module graph fresh for each test (vi.resetModules).
let home: string;
let provider: LHP;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function freshProvider(): Promise<LHP> {
  vi.resetModules();
  const { LocalHostProvider } = await import('./local.js');
  return new LocalHostProvider();
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hosts-test-'));
  process.env.HOME = home;
  // ssh-config reader resolves via os.homedir(), which reads USERPROFILE (not
  // HOME) on Windows — set both so the temp home takes effect cross-platform.
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  provider = await freshProvider();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe('LocalHostProvider CRUD', () => {
  it('registers, lists, resolves, and removes an inline host', async () => {
    await provider.register!({ name: 's1', provider: 'local', source: 'inline', address: 'yosemite-s1', user: 'muqsit', caps: ['gpu'] });

    const listed = await provider.list();
    const s1 = listed.find((h) => h.name === 's1');
    expect(s1).toBeDefined();
    expect(s1!.source).toBe('inline');
    expect(s1!.address).toBe('yosemite-s1');
    expect(s1!.user).toBe('muqsit');
    expect(s1!.caps).toEqual(['gpu']);
    expect(s1!.enrolled).toBe(true);

    const resolved = await provider.resolve('s1');
    expect(resolved?.address).toBe('yosemite-s1');

    await provider.remove!('s1');
    expect(await provider.resolve('s1')).toBeNull();
    expect((await provider.list()).find((h) => h.name === 's1')).toBeUndefined();
  });

  it('persists across provider instances (written to agents.yaml)', async () => {
    await provider.register!({ name: 'box', provider: 'local', source: 'inline', address: '10.0.0.5' });
    const reloaded = await freshProvider();
    expect((await reloaded.resolve('box'))?.address).toBe('10.0.0.5');
  });
});

describe('LocalHostProvider ssh-config union + resolution order', () => {
  it('lists ssh-config hosts as available (not enrolled) and unions with inline', async () => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host cfg-box\n  HostName 1.2.3.4\n  User me\n', 'utf-8');
    provider = await freshProvider();

    await provider.register!({ name: 'inline-box', provider: 'local', source: 'inline', address: '9.9.9.9' });

    const list = await provider.list();
    const cfg = list.find((h) => h.name === 'cfg-box');
    const inline = list.find((h) => h.name === 'inline-box');
    expect(cfg).toBeDefined();
    expect(cfg!.source).toBe('ssh-config');
    expect(cfg!.enrolled).toBe(false); // dispatchable but not enrolled
    expect(cfg!.address).toBeUndefined(); // connection details stay in ssh config
    expect(inline!.enrolled).toBe(true);

    // ssh-config host resolves without registration
    expect((await provider.resolve('cfg-box'))?.source).toBe('ssh-config');
  });

  it('an inline overlay wins over an ssh-config host of the same name', async () => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host dup\n  HostName 1.1.1.1\n', 'utf-8');
    provider = await freshProvider();
    await provider.register!({ name: 'dup', provider: 'local', source: 'inline', address: '2.2.2.2', caps: ['gpu'] });

    const resolved = await provider.resolve('dup');
    expect(resolved?.source).toBe('inline');
    expect(resolved?.address).toBe('2.2.2.2');
    expect(resolved?.caps).toEqual(['gpu']);
    // not duplicated in the list
    expect((await provider.list()).filter((h) => h.name === 'dup')).toHaveLength(1);
  });
});
