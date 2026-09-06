import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import * as yaml from 'yaml';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import type { AddressInfo } from 'net';
import * as state from '../state.js';
import * as profiles from './profiles.js';
import { machineId } from '../machine-id.js';

// ─── Same-task reopen over the REAL IPC socket + REAL Chromium (PHNX-2399) ─────
//
// Distinct from service.reopen.live.test.ts (direct service calls): this drives
// the contract through the actual BrowserIPCServer over an isolated unix socket
// with INDEPENDENT client connections, backed by a real chrome-headless-shell —
// covering implicit first-open, named-start retry, cross-connection concurrency,
// and reconstruction from the persisted tasks.json. Same gating as the sibling
// live test (AGENTS_TEST_CHROME [+ AGENTS_TEST_CHROME_LIBS]); skips with no browser.
const CHROME = process.env.AGENTS_TEST_CHROME;
const LIBS = process.env.AGENTS_TEST_CHROME_LIBS;
const haveChrome = !!(CHROME && fs.existsSync(CHROME));

const TEST_HOME = path.join(tmpdir(), 'agents-cli-reopen-ipc-test');
const TEST_AGENTS_DIR = path.join(TEST_HOME, '.agents');
const TEST_BROWSER_DIR = path.join(TEST_AGENTS_DIR, 'browser');

vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);
vi.spyOn(profiles, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);
vi.spyOn(profiles, 'getProfileRuntimeDir').mockImplementation((name: string) => path.join(TEST_BROWSER_DIR, name));

function readProfileYaml(name: string): { name: string; browser: string; endpoints: string[] } | null {
  const p = path.join(TEST_BROWSER_DIR, 'profiles', `${name}.yaml`);
  if (!fs.existsSync(p)) return null;
  const raw = yaml.parse(fs.readFileSync(p, 'utf-8')) as { name: string; browser: string; endpoints: string[] };
  return { name: raw.name, browser: raw.browser, endpoints: raw.endpoints };
}
vi.spyOn(profiles, 'listProfiles').mockImplementation(async () => {
  const dir = path.join(TEST_BROWSER_DIR, 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => readProfileYaml(path.basename(f, '.yaml'))).filter((x): x is { name: string; browser: string; endpoints: string[] } => x !== null);
});
vi.spyOn(profiles, 'getProfile').mockImplementation(async (name: string) => readProfileYaml(name));

const { BrowserService } = await import('./service.js');
const { BrowserIPCServer } = await import('./ipc.js');
const { CDPClient, discoverBrowserWsUrl } = await import('./cdp.js');
const { profileConnectionKey } = await import('./resolve-target.js');

const PROFILE = 'reopenipc';
const COMPOSITE = profileConnectionKey(PROFILE, machineId());

function writeProfile(name: string): void {
  const profile = { name, browser: 'chrome', endpoints: ['cdp://localhost:9222'] };
  fs.mkdirSync(path.join(TEST_BROWSER_DIR, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(TEST_BROWSER_DIR, 'profiles', `${name}.yaml`), yaml.stringify(profile));
  const file = path.join(TEST_AGENTS_DIR, 'devices', machineId(), 'agents.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = fs.existsSync(file) ? (yaml.parse(fs.readFileSync(file, 'utf8')) as { browser?: Record<string, unknown> }) ?? {} : {};
  fs.writeFileSync(file, yaml.stringify({ ...doc, browser: { ...(doc.browser ?? {}), [name]: { browser: 'chrome', endpoints: ['cdp://localhost:9222'] } } }));
}

/** One request over its OWN short-lived socket connection (independent client). */
function ipcCall(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
        sock.end();
      }
    });
    sock.on('error', reject);
  });
}

const d = haveChrome ? describe : describe.skip;

d('same-task reopen over the real IPC socket + real Chromium (PHNX-2399)', () => {
  let chrome: ChildProcess;
  let httpServer: http.Server;
  let httpPort: number;
  let cdp: InstanceType<typeof CDPClient>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let conn: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let socketPath: string;

  const urlFor = (p: string) => `http://127.0.0.1:${httpPort}/reopen-counter.html?p=${p}`;
  const pageTargets = async () => {
    const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    return targetInfos.filter((t) => t.type === 'page');
  };
  const targetsForUrl = async (url: string) => (await pageTargets()).filter((t) => t.url === url);

  beforeAll(async () => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BROWSER_DIR, { recursive: true });
    writeProfile(PROFILE);

    httpServer = http.createServer((req, res) => {
      const rel = (req.url || '/').split('?')[0].replace(/^\/+/, '');
      const file = path.join(import.meta.dirname, 'testdata', path.basename(rel));
      if (!file.startsWith(path.join(import.meta.dirname, 'testdata')) || !fs.existsSync(file)) { res.statusCode = 404; res.end('nf'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    httpPort = (httpServer.address() as AddressInfo).port;

    const udd = fs.mkdtempSync(path.join(tmpdir(), 'reopen-ipc-udd-'));
    const cdpPort = 9600 + Math.floor(Date.now() % 300);
    chrome = spawn(CHROME!, ['--headless', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${udd}`, 'about:blank'], { env: { ...process.env, ...(LIBS ? { LD_LIBRARY_PATH: LIBS } : {}) }, stdio: 'ignore' });
    let wsUrl: string | undefined;
    for (let i = 0; i < 60; i++) {
      try { wsUrl = (await discoverBrowserWsUrl(cdpPort, '127.0.0.1', PROFILE)).wsUrl; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!wsUrl) throw new Error('Chromium never exposed a CDP endpoint');
    cdp = new CDPClient();
    await cdp.connect(wsUrl);

    service = new BrowserService();
    // Register the real-Chromium connection under the key start() resolves to, so
    // start()/navigate route here and REUSE it (no second browser launched).
    conn = { cdp, port: cdpPort, pid: chrome.pid ?? 1, browserType: 'chrome', key: COMPOSITE, profile: PROFILE, tasks: new Map(), sessionCache: new Map() };
    service.connections.set(COMPOSITE, conn);

    socketPath = path.join(TEST_BROWSER_DIR, 'test-ipc.sock');
    server = new BrowserIPCServer(service, socketPath);
    await server.start();
  }, 40_000);

  afterAll(async () => {
    try { await server?.stop(); } catch { /* ignore */ }
    try { cdp?.close?.(); } catch { /* ignore */ }
    try { chrome?.kill('SIGKILL'); } catch { /* ignore */ }
    try { httpServer?.close(); } catch { /* ignore */ }
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('implicit first-open opens the URL exactly once, then a reopen refreshes the same tab', async () => {
    const first = await ipcCall(socketPath, { action: 'navigate', url: urlFor('P'), profile: PROFILE, sessionId: 'ipc-s1', launchId: 'ipc-l1', actor: 'tester' });
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(first.refreshed).toBe(false);
    expect(await targetsForUrl(urlFor('P'))).toHaveLength(1); // exactly one open — no double execution

    const again = await ipcCall(socketPath, { action: 'navigate', url: urlFor('P'), profile: PROFILE, sessionId: 'ipc-s1', launchId: 'ipc-l1', actor: 'tester' });
    expect(again.ok).toBe(true);
    expect(again.refreshed).toBe(true);
    expect(again.tabId).toBe(first.tabId); // SAME tab id
    expect(String(again.message)).toContain('Tab already open—refreshed');
    expect(await targetsForUrl(urlFor('P'))).toHaveLength(1); // still one target
  }, 40_000);

  it('two INDEPENDENT socket connections adding one URL create ONE target, same id', async () => {
    const task = 'ipc-concurrent';
    // Seed the task via one start so both concurrent requests carry --task.
    await ipcCall(socketPath, { action: 'start', profile: PROFILE, taskName: task, sessionId: 'ipc-s2', launchId: 'ipc-l2', actor: 'tester' });
    const before = (await pageTargets()).length;
    const [r1, r2] = await Promise.all([
      ipcCall(socketPath, { action: 'tab-add', task, url: urlFor('Q'), profile: PROFILE, sessionId: 'ipc-s2', launchId: 'ipc-l2', actor: 'tester' }),
      ipcCall(socketPath, { action: 'tab-add', task, url: urlFor('Q'), profile: PROFILE, sessionId: 'ipc-s2', launchId: 'ipc-l2', actor: 'tester' }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.tabId).toBe(r2.tabId);
    expect([r1, r2].filter((r) => r.created).length).toBe(1);
    expect([r1, r2].filter((r) => r.refreshed).length).toBe(1);
    // Total page-target delta is exactly 1 — the two requests converged on one
    // tab. (Counting by exact URL races the reload's transient loading state.)
    expect((await pageTargets()).length).toBe(before + 1);
  }, 40_000);

  it('two concurrent same-NAME starts create ONE task and the loser reuses it', async () => {
    const task = 'ipc-race';
    const [a, b] = await Promise.all([
      ipcCall(socketPath, { action: 'start', profile: PROFILE, taskName: task, url: urlFor('T'), sessionId: 'ipc-s5', launchId: 'ipc-l5', actor: 'tester' }),
      ipcCall(socketPath, { action: 'start', profile: PROFILE, taskName: task, url: urlFor('T'), sessionId: 'ipc-s5', launchId: 'ipc-l5', actor: 'tester' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.task).toBe(b.task); // one task, two requests
    // Exactly one opened the tab; the other took the retry (reload) path.
    expect([a, b].filter((r) => r.refreshed === true).length).toBe(1);
  }, 40_000);

  it('a same-name start retry over IPC reuses the task; a different profile is refused', async () => {
    const task = 'ipc-named';
    const s1 = await ipcCall(socketPath, { action: 'start', profile: PROFILE, taskName: task, url: urlFor('R'), sessionId: 'ipc-s3', launchId: 'ipc-l3', actor: 'tester' });
    expect(s1.ok).toBe(true);
    const s2 = await ipcCall(socketPath, { action: 'start', profile: PROFILE, taskName: task, url: urlFor('R'), sessionId: 'ipc-s3', launchId: 'ipc-l3', actor: 'tester' });
    expect(s2.ok).toBe(true);
    expect(s2.refreshed).toBe(true); // reused, not a fresh start
    expect(s2.tabId).toBe(s1.tabId); // same tab reloaded in place

    // A DIFFERENT caller must not silently acquire this task.
    const callerConflict = await ipcCall(socketPath, { action: 'start', profile: PROFILE, taskName: task, url: urlFor('R'), sessionId: 'ipc-OTHER', launchId: 'ipc-OTHER', actor: 'someone-else' });
    expect(callerConflict.ok).toBe(false);
    expect(String(callerConflict.error)).toMatch(/different caller/);

    // A DIFFERENT profile is refused too.
    writeProfile('otherprofile');
    const conflict = await ipcCall(socketPath, { action: 'start', profile: 'otherprofile', taskName: task, url: urlFor('R'), sessionId: 'ipc-s3', launchId: 'ipc-l3', actor: 'tester' });
    expect(conflict.ok).toBe(false);
    expect(String(conflict.error)).toMatch(/already exists on profile/);
  }, 40_000);

  it('persists task+tab ids to tasks.json and reopens the SAME id after reconstructing the service', async () => {
    const task = 'ipc-persist';
    const opened = await ipcCall(socketPath, { action: 'start', profile: PROFILE, taskName: task, url: urlFor('S'), sessionId: 'ipc-s4', launchId: 'ipc-l4', actor: 'tester' });
    expect(opened.ok).toBe(true);

    // The canonical persistence is on disk, not just in memory.
    const tasksFile = path.join(TEST_BROWSER_DIR, COMPOSITE, 'tasks.json');
    const persisted = JSON.parse(fs.readFileSync(tasksFile, 'utf8')) as Record<string, { tabs: Record<string, string>; currentTabId?: string }>;
    expect(persisted[task]).toBeTruthy();
    expect(Object.keys(persisted[task].tabs)).toContain(String(opened.tabId));

    // Reconstruct a fresh service from the persisted state against the SAME live
    // browser, and prove a reopen retains the id (recovery, not in-memory replay).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service2: any = new BrowserService();
    const tasks = new Map<string, unknown>(Object.entries(persisted));
    service2.connections.set(COMPOSITE, { cdp, port: conn.port, pid: conn.pid, browserType: 'chrome', key: COMPOSITE, profile: PROFILE, tasks, sessionCache: new Map() });
    const reopened = await service2.navigate(task, urlFor('S'), COMPOSITE);
    expect(reopened.refreshed).toBe(true); // matched the persisted owned tab
    expect(reopened.tabId).toBe(opened.tabId); // id survived reconstruction
    // The SAME CDP target was reloaded (not a new one), proving reconstruction
    // reused the persisted mapping. (URL-based counting races the reload's
    // transient loading state, so assert on the retained target id instead.)
    expect(service2.connections.get(COMPOSITE).tasks.get(task).tabs[reopened.tabId])
      .toBe(persisted[task].tabs[String(opened.tabId)]);
  }, 40_000);
});
