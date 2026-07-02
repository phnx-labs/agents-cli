// Action verbs for `agents computer` — the interaction surface over the
// computer-helper daemon's RPC methods (click, type, key, drag, scroll,
// describe, ax-action, focus, ...). These mirror `agents browser`'s verb
// layout: flat verbs under the noun, bundle-id targeting, --json on reads.
//
// The daemon already implements every method; this file is the thin, typed
// CLI skin over it plus a shared target resolver so callers stay in bundle-id
// space and never hand-manage pids.

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  openComputerClient,
  describeTransport,
  resolvePolicyPath,
  type ComputerClient,
  type RPCResponse,
} from '../lib/computer-rpc.js';
import {
  COMPUTER_INPUT_GATED_VERBS,
  formatComputerPermissionGrantHint,
} from '../lib/permissions.js';

export interface AppInfo {
  pid: number;
  name: string;
  bundle_id: string;
  active: boolean;
}

type ComputerInputVerb = typeof COMPUTER_INPUT_GATED_VERBS[number];

interface TargetAdmission {
  sessionId: string;
  selector: string;
  gateClass: 'input';
  pid: number;
  bundle_id: string;
  name: string;
  admittedAtMs: number;
  admittedByVerb: ComputerInputVerb;
}

interface AdmissionCacheFile {
  admissions?: TargetAdmission[];
}

function isComputerInputVerb(verb: string | undefined): verb is ComputerInputVerb {
  return typeof verb === 'string' && (COMPUTER_INPUT_GATED_VERBS as readonly string[]).includes(verb);
}

function computerSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CODEX_THREAD_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CLAUDE_SESSION_ID
    || env.AGENTS_SESSION_ID
    || env.AGENTS_RUN_ID
    || null;
}

function admissionCachePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTS_COMPUTER_ADMISSION_CACHE) return env.AGENTS_COMPUTER_ADMISSION_CACHE;
  return path.join(path.dirname(resolvePolicyPath()), 'computer-target-admissions.json');
}

function targetSelector(opts: { bundle?: string }): string {
  return opts.bundle ? `bundle:${opts.bundle}` : 'frontmost';
}

function readAdmissionCache(filePath: string): TargetAdmission[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AdmissionCacheFile;
    return Array.isArray(parsed.admissions) ? parsed.admissions.filter(isAdmission) : [];
  } catch {
    return [];
  }
}

function isAdmission(v: unknown): v is TargetAdmission {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.sessionId !== undefined
    && typeof r.sessionId === 'string'
    && typeof r.selector === 'string'
    && r.gateClass === 'input'
    && typeof r.pid === 'number'
    && typeof r.bundle_id === 'string'
    && typeof r.name === 'string'
    && typeof r.admittedAtMs === 'number'
    && isComputerInputVerb(r.admittedByVerb as string | undefined);
}

function rememberAdmission(app: AppInfo, opts: {
  selector: string;
  verb: ComputerInputVerb;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): void {
  const sessionId = computerSessionId(opts.env);
  if (!sessionId) return;

  const filePath = admissionCachePath(opts.env);
  const admissions = readAdmissionCache(filePath);
  const next: TargetAdmission = {
    sessionId,
    selector: opts.selector,
    gateClass: 'input',
    pid: app.pid,
    bundle_id: app.bundle_id,
    name: app.name,
    admittedAtMs: opts.nowMs ?? Date.now(),
    admittedByVerb: opts.verb,
  };
  const filtered = admissions.filter((a) =>
    !(a.sessionId === sessionId && a.selector === opts.selector && a.gateClass === 'input')
  );
  filtered.push(next);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ admissions: filtered }, null, 2), { mode: 0o600 });
  } catch {
    // Cache persistence is best-effort; the daemon remains the final gate.
  }
}

function findAdmission(opts: {
  selector: string;
  env?: NodeJS.ProcessEnv;
}): TargetAdmission | null {
  const sessionId = computerSessionId(opts.env);
  if (!sessionId) return null;
  const admissions = readAdmissionCache(admissionCachePath(opts.env));
  const matches = admissions
    .filter((a) => a.sessionId === sessionId && a.selector === opts.selector && a.gateClass === 'input')
    .sort((a, b) => b.admittedAtMs - a.admittedAtMs);
  return matches[0] ?? null;
}

// Pure target picker — exercised by unit tests. Precedence: explicit --pid,
// then --bundle, then the frontmost active allow-listed app (the same default
// `screenshot` uses). Kept side-effect-free so the resolution rules are
// testable without a live daemon.
export function pickTarget(
  list: AppInfo[],
  opts: { pid?: number; bundle?: string },
): { ok: true; app: AppInfo } | { ok: false; error: string } {
  if (opts.pid != null) {
    const app = list.find((a) => a.pid === opts.pid);
    // A --pid the daemon doesn't list (not allow-listed / not running) is
    // still passed through: the daemon is the authority and will return a
    // precise permission_denied / app_not_found. We don't second-guess it.
    return { ok: true, app: app ?? { pid: opts.pid, name: '', bundle_id: '', active: false } };
  }
  if (opts.bundle) {
    const app = list.find((a) => a.bundle_id === opts.bundle);
    if (!app) {
      return {
        ok: false,
        error: `bundle not in allow list (or not running): ${opts.bundle}\n${formatComputerPermissionGrantHint(opts.bundle)}`,
      };
    }
    return { ok: true, app };
  }
  const active = list.find((a) => a.active);
  if (!active) {
    return {
      ok: false,
      error: `no active app found in allow list\n${formatComputerPermissionGrantHint()}`,
    };
  }
  return { ok: true, app: active };
}

// Parse an "x,y" coordinate pair. Pure + tested.
export function parseXY(s: string, flag: string): { x: number; y: number } {
  const parts = s.split(',').map((v) => v.trim());
  if (parts.length !== 2) {
    throw new Error(`${flag} must be "x,y" (got: ${s})`);
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${flag} must be two numbers "x,y" (got: ${s})`);
  }
  return { x, y };
}

// Build the element-or-coords target spec shared by click/type/scroll/etc.
// Pure + tested: returns the params fragment or an error string.
export function buildElementOrCoords(opts: {
  id?: string;
  x?: number;
  y?: number;
}): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  if (opts.id) return { ok: true, params: { element_id: opts.id } };
  if (opts.x != null && opts.y != null) return { ok: true, params: { x: opts.x, y: opts.y } };
  return { ok: false, error: 'pass --id <@eN> (from `describe`) or --x <n> --y <n>' };
}

// Build the focus_window params for `raise`. Pure + tested: window_id and
// title are both optional refinements over the app-level activate.
export function buildRaiseParams(opts: {
  windowId?: number;
  title?: string;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (opts.windowId != null) params.window_id = opts.windowId;
  if (opts.title) params.title = opts.title;
  return params;
}

// Inter-character typing delay for type-text. Default 4ms matches the daemon's
// historical fixed rate; lossy keyboard relays (Parallels/VM guests) drop chars
// at that rate, so callers can raise it. Clamp to [1, 250]ms CLI-side (the
// daemon clamps too — defense in depth). Returns undefined when unset so the
// daemon applies its own default. Pure + tested.
export const CHAR_DELAY_MIN_MS = 1;
export const CHAR_DELAY_MAX_MS = 250;
export function clampCharDelay(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return Math.min(CHAR_DELAY_MAX_MS, Math.max(CHAR_DELAY_MIN_MS, Math.trunc(ms)));
}

// Build the wait RPC params. Pure + tested. Three modes, mirroring the
// daemon's Wait.run: --duration (unconditional sleep), --id + --until
// (cached-element poll), or --role/--label/--identifier (live locator poll).
export function buildWaitParams(opts: {
  duration?: number;
  id?: string;
  until?: string;
  role?: string;
  label?: string;
  identifier?: string;
  timeout?: number;
}): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  if (opts.duration != null) {
    return { ok: true, params: { duration_ms: opts.duration } };
  }
  const params: Record<string, unknown> = {};
  if (opts.until) params.until = opts.until;
  if (opts.timeout != null) params.timeout_ms = opts.timeout;
  if (opts.id) {
    return { ok: true, params: { ...params, element_id: opts.id } };
  }
  const locator: Record<string, string> = {};
  if (opts.role) locator.role = opts.role;
  if (opts.label) locator.label = opts.label;
  if (opts.identifier) locator.identifier = opts.identifier;
  if (Object.keys(locator).length === 0) {
    return { ok: false, error: 'pass --duration <ms>, --id <@eN>, or a locator (--role/--label/--identifier)' };
  }
  return { ok: true, params: { ...params, locator } };
}

// postToPid keyboard delivery is dropped by key-window-gated apps (Parallels
// VMs and friends) — when the daemon reports the target was not frontmost,
// the keystrokes may have landed nowhere. Surface that loudly on stderr.
function warnIfNotFrontmost(res: Record<string, unknown>): void {
  if (res.frontmost === false) {
    console.error('warning: target was not the frontmost app — keystrokes may have been dropped. Run `agents computer raise` first.');
  }
}

function reportMissingHelper(): never {
  console.error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
  process.exit(1);
}

// Open a client, run fn, always close. Fails fast if no helper is present.
export async function withClient<T>(fn: (client: ComputerClient) => Promise<T>): Promise<T> {
  if (describeTransport().kind === 'none') reportMissingHelper();
  const client = openComputerClient();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Unwrap an RPC response: print + exit on error, else return result.
export function unwrap(r: RPCResponse): Record<string, unknown> {
  if (r.error) {
    console.error(`error: ${r.error.code}: ${r.error.message}`);
    process.exit(1);
  }
  return r.result ?? {};
}

export async function resolveTargetPidDecision(
  client: ComputerClient,
  opts: { pid?: number; bundle?: string },
  gate?: { verb?: string; env?: NodeJS.ProcessEnv; nowMs?: number },
): Promise<{ ok: true; pid: number; source: 'pid' | 'list_apps' | 'session_admission' } | { ok: false; error: string }> {
  // A directly-supplied pid skips the list_apps roundtrip — the daemon gates.
  if (opts.pid != null) return { ok: true, pid: opts.pid, source: 'pid' };
  const apps = unwrap(await client.call('list_apps'));
  const list = (apps.apps as AppInfo[]) || [];
  const picked = pickTarget(list, opts);
  const verb = gate?.verb;
  const selector = targetSelector(opts);
  if (picked.ok && isComputerInputVerb(verb)) {
    rememberAdmission(picked.app, { selector, verb, env: gate?.env, nowMs: gate?.nowMs });
  }
  if (!picked.ok) {
    if (isComputerInputVerb(verb)) {
      const admitted = findAdmission({ selector, env: gate?.env });
      if (admitted) return { ok: true, pid: admitted.pid, source: 'session_admission' };
    }
    return { ok: false, error: picked.error };
  }
  return { ok: true, pid: picked.app.pid, source: 'list_apps' };
}

// Resolve the target pid via list_apps + pickTarget, printing a precise error
// and exiting when no target matches.
async function resolveTargetPid(
  client: ComputerClient,
  opts: { pid?: number; bundle?: string },
  gate?: { verb?: string },
): Promise<number> {
  const resolved = await resolveTargetPidDecision(client, opts, gate);
  if (!resolved.ok) {
    console.error(resolved.error);
    process.exit(1);
  }
  return resolved.pid;
}

// --raise flag: app-level focus_window before the main action so coordinate
// clicks and keystrokes land on a visible, key window.
async function raiseIfRequested(client: ComputerClient, pid: number, raise?: boolean): Promise<void> {
  if (raise) unwrap(await client.call('focus_window', { pid }));
}

function emit(result: Record<string, unknown>, json: boolean, human: () => string): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(human());
  }
}

// Add the shared --pid/--bundle/--host target options to a verb. `--host` routes
// the verb at a remote Windows device: the `computer` preAction hook hydrates
// COMPUTER_HELPER_TCP from the tunnel `start --host` recorded, so withClient's
// openComputerClient() transparently selects the TCP transport.
function addTargetOpts(cmd: Command): Command {
  return cmd
    .option('--bundle <id>', 'Bundle id of the target app (default: frontmost allow-listed app)')
    .option('--pid <n>', 'Target pid directly (overrides --bundle)', (v) => parseInt(v, 10))
    .option('--host <device>', 'Drive a remote Windows device (requires `agents computer start --host <device>` first)');
}

// Add the shared --id/--x/--y element-or-coords options to a verb.
function addElementOrCoordOpts(cmd: Command): Command {
  return cmd
    .option('--id <@eN>', 'Element id from `describe`')
    .option('--x <n>', 'X coordinate (global, points)', (v) => parseInt(v, 10))
    .option('--y <n>', 'Y coordinate (global, points)', (v) => parseInt(v, 10));
}

type TargetOpts = { pid?: number; bundle?: string; host?: string; json?: boolean };
type ElemOpts = TargetOpts & { id?: string; x?: number; y?: number };

export function registerActionCommands(program: Command): void {
  // apps — list_apps
  addTargetOpts(
    program
      .command('apps')
      .description('List apps the daemon may drive (allow-listed + running)')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts) => {
    await withClient(async (client) => {
      const res = unwrap(await client.call('list_apps'));
      const list = (res.apps as AppInfo[]) || [];
      emit(res, Boolean(opts.json), () =>
        list.length === 0
          ? '(no allow-listed apps running)'
          : list
              .map((a) => `${a.active ? '*' : ' '} ${String(a.pid).padStart(6)}  ${a.bundle_id}  ${a.name}`)
              .join('\n'),
      );
    });
  });

  // describe — AX tree
  addTargetOpts(
    program
      .command('describe')
      .description('Dump the accessibility tree (element ids feed click/type --id)')
      .option('--depth <n>', 'Max tree depth', (v) => parseInt(v, 10))
      .option('--json', 'Emit compact JSON (default: pretty)'),
  ).action(async (opts: TargetOpts & { depth?: number }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'describe' });
      const params: Record<string, unknown> = { pid };
      if (opts.depth != null) params.max_depth = opts.depth;
      const res = unwrap(await client.call('describe', params));
      // The tree is inherently structured — always JSON, pretty unless --json.
      console.log(JSON.stringify(opts.json ? res : res.tree ?? res, null, 2));
    });
  });

  // click
  addElementOrCoordOpts(
    addTargetOpts(
      program
        .command('click')
        .description('Click an element (--id) or screen coordinate (--x --y)')
        .option('--count <n>', 'Click count (2 = double-click)', (v) => parseInt(v, 10))
        .option('--background', 'Focus-safe postToPid delivery (plain AppKit only; skips HID tap)')
        .option('--raise', 'Bring the target app to the front first')
        .option('--json', 'Emit JSON'),
    ),
  ).action(async (opts: ElemOpts & { count?: number; background?: boolean; raise?: boolean }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'click' });
      const spec = buildElementOrCoords(opts);
      if (!spec.ok) {
        console.error(spec.error);
        process.exit(1);
      }
      await raiseIfRequested(client, pid, opts.raise);
      const params: Record<string, unknown> = { pid, ...spec.params };
      if (opts.count != null) params.count = opts.count;
      if (opts.background) params.background = true;
      const res = unwrap(await client.call('click', params));
      emit(res, Boolean(opts.json), () => `clicked (${res.action ?? 'ok'})`);
    });
  });

  // right-click
  addElementOrCoordOpts(
    addTargetOpts(
      program
        .command('right-click')
        .description('Right-click (context menu) an element or coordinate')
        .option('--json', 'Emit JSON'),
    ),
  ).action(async (opts: ElemOpts) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'right-click' });
      const spec = buildElementOrCoords(opts);
      if (!spec.ok) {
        console.error(spec.error);
        process.exit(1);
      }
      const res = unwrap(await client.call('right_click', { pid, ...spec.params }));
      emit(res, Boolean(opts.json), () => `right-clicked (${res.method ?? 'ok'})`);
    });
  });

  // type — set value on a field (--id) or paste at coords, optional commit
  addElementOrCoordOpts(
    addTargetOpts(
      program
        .command('type')
        .description('Set a field value (--id) or paste at a coordinate (--x --y)')
        .requiredOption('--text <s>', 'Text to enter')
        .option('--commit', 'Commit after typing (AXConfirm / Return) so the value reaches the model')
        .option('--allow-secure-field', 'Permit typing into a password field')
        .option('--json', 'Emit JSON'),
    ),
  ).action(async (opts: ElemOpts & { text: string; commit?: boolean; allowSecureField?: boolean }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'type' });
      const spec = buildElementOrCoords(opts);
      if (!spec.ok) {
        console.error(spec.error);
        process.exit(1);
      }
      const params: Record<string, unknown> = { pid, ...spec.params, text: opts.text };
      if (opts.commit) params.commit = true;
      if (opts.allowSecureField) params.allow_secure_field = true;
      const res = unwrap(await client.call('type', params));
      emit(res, Boolean(opts.json), () => `typed ${opts.text.length} char(s)${res.committed ? ' (committed)' : ''}`);
    });
  });

  // type-text — stream an arbitrary unicode string into the focused field
  addTargetOpts(
    program
      .command('type-text')
      .description('Type an arbitrary unicode string into the focused field (focus first via click/focus)')
      .requiredOption('--text <s>', 'Text to type')
      .option('--commit', 'Press Return after typing')
      .option('--raise', 'Bring the target app to the front first')
      .option('--require-frontmost', 'Fail (not warn) if the target is not the frontmost app')
      .option('--char-delay <ms>', 'Inter-character delay in ms (default 4; raise for lossy keyboard relays like VM guests, e.g. 25). Clamped to [1, 250].', (v) => parseInt(v, 10))
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { text: string; commit?: boolean; raise?: boolean; requireFrontmost?: boolean; charDelay?: number }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'type-text' });
      await raiseIfRequested(client, pid, opts.raise);
      const params: Record<string, unknown> = { pid, text: opts.text };
      if (opts.commit) params.commit = true;
      if (opts.requireFrontmost) params.require_frontmost = true;
      const charDelay = clampCharDelay(opts.charDelay);
      if (charDelay !== undefined) params.char_delay_ms = charDelay;
      const res = unwrap(await client.call('type_text', params));
      warnIfNotFrontmost(res);
      emit(res, Boolean(opts.json), () => `typed ${res.chars ?? opts.text.length} char(s)`);
    });
  });

  // key — single chord
  addTargetOpts(
    program
      .command('key')
      .description('Send a key chord, e.g. "cmd+shift+s", "enter", "esc"')
      .requiredOption('--keys <chord>', 'Key chord')
      .option('--raise', 'Bring the target app to the front first')
      .option('--require-frontmost', 'Fail (not warn) if the target is not the frontmost app')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { keys: string; raise?: boolean; requireFrontmost?: boolean }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'key' });
      await raiseIfRequested(client, pid, opts.raise);
      const params: Record<string, unknown> = { pid, keys: opts.keys };
      if (opts.requireFrontmost) params.require_frontmost = true;
      const res = unwrap(await client.call('key', params));
      warnIfNotFrontmost(res);
      emit(res, Boolean(opts.json), () => `sent ${opts.keys}`);
    });
  });

  // drag — from one point to another
  addTargetOpts(
    program
      .command('drag')
      .description('Drag from one coordinate to another')
      .requiredOption('--from <x,y>', 'Start coordinate "x,y"')
      .requiredOption('--to <x,y>', 'End coordinate "x,y"')
      .option('--button <left|right>', 'Mouse button', 'left')
      .option('--background', 'Focus-safe postToPid delivery (plain AppKit only)')
      .option('--raise', 'Bring the target app to the front first')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { from: string; to: string; button: string; background?: boolean; raise?: boolean }) => {
    let from: { x: number; y: number };
    let to: { x: number; y: number };
    try {
      from = parseXY(opts.from, '--from');
      to = parseXY(opts.to, '--to');
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'drag' });
      await raiseIfRequested(client, pid, opts.raise);
      const params: Record<string, unknown> = {
        pid,
        from: [from.x, from.y],
        to: [to.x, to.y],
        button: opts.button,
      };
      if (opts.background) params.background = true;
      const res = unwrap(await client.call('drag', params));
      emit(res, Boolean(opts.json), () => `dragged ${opts.from} -> ${opts.to} (${res.method ?? 'ok'})`);
    });
  });

  // scroll — by delta at an element or coordinate
  addElementOrCoordOpts(
    addTargetOpts(
      program
        .command('scroll')
        .description('Scroll by a pixel delta at an element or coordinate')
        .option('--dy <n>', 'Vertical delta (negative = down)', (v) => parseInt(v, 10))
        .option('--dx <n>', 'Horizontal delta', (v) => parseInt(v, 10))
        .option('--raise', 'Bring the target app to the front first')
        .option('--json', 'Emit JSON'),
    ),
  ).action(async (opts: ElemOpts & { dy?: number; dx?: number; raise?: boolean }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'scroll' });
      await raiseIfRequested(client, pid, opts.raise);
      const params: Record<string, unknown> = { pid };
      if (opts.id) params.element_id = opts.id;
      if (opts.x != null) params.x = opts.x;
      if (opts.y != null) params.y = opts.y;
      if (opts.dy != null) params.dy = opts.dy;
      if (opts.dx != null) params.dx = opts.dx;
      const res = unwrap(await client.call('scroll', params));
      emit(res, Boolean(opts.json), () => `scrolled (${res.method ?? 'ok'})`);
    });
  });

  // ax-action — perform any advertised AX action on an element
  addTargetOpts(
    program
      .command('ax-action')
      .description('Perform an arbitrary AX action (AXConfirm, AXCancel, AXRaise, ...) on an element')
      .requiredOption('--id <@eN>', 'Element id from `describe`')
      .requiredOption('--action <name>', 'AX action name')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { id: string; action: string }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'ax-action' });
      const res = unwrap(await client.call('ax_action', { pid, element_id: opts.id, action: opts.action }));
      emit(res, Boolean(opts.json), () => `performed ${opts.action}`);
    });
  });

  // focus — set keyboard focus to an element
  addTargetOpts(
    program
      .command('focus')
      .description('Set keyboard focus to an element (so type-text/key land there)')
      .requiredOption('--id <@eN>', 'Element id from `describe`')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { id: string }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'focus' });
      const res = unwrap(await client.call('set_focus', { pid, element_id: opts.id }));
      emit(res, Boolean(opts.json), () => `focused ${opts.id}`);
    });
  });

  // raise — bring an app (or one of its windows) to the front. The window
  // forms (--window-id/--title) also switch macOS Spaces, which is the only
  // way to reach a fullscreen-Space window (VM, fullscreen editor) for
  // capture and HID-tap input.
  addTargetOpts(
    program
      .command('raise')
      .description('Bring an app (or a specific window) to the front — switches Spaces for fullscreen windows')
      .option('--window-id <n>', 'Raise a specific window by id (from `screenshot --list`)', (v) => parseInt(v, 10))
      .option('--title <s>', 'Raise the window whose title contains this string')
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { windowId?: number; title?: string }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'raise' });
      const res = unwrap(await client.call('focus_window', { pid, ...buildRaiseParams(opts) }));
      emit(res, Boolean(opts.json), () => {
        const scope = res.raised_window ? `window ${res.title ?? res.window_id ?? ''}`.trim() : 'app';
        return `raised ${scope} (${res.focus_elapsed_ms ?? 0}ms)`;
      });
    });
  });

  // wait — settle the UI before the next action
  addTargetOpts(
    program
      .command('wait')
      .description('Wait for a duration (--duration) or for an element (--id / --role/--label) to satisfy --until')
      .option('--duration <ms>', 'Unconditional sleep in ms (50-30000)', (v) => parseInt(v, 10))
      .option('--id <@eN>', 'Element id from `describe` to poll')
      .option('--until <cond>', 'Condition: exists | enabled | disappears (default: exists)')
      .option('--role <s>', 'Locator: AX role (e.g. AXButton)')
      .option('--label <s>', 'Locator: element label')
      .option('--identifier <s>', 'Locator: AX identifier')
      .option('--timeout <ms>', 'Poll timeout in ms (default 5000)', (v) => parseInt(v, 10))
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { duration?: number; id?: string; until?: string; role?: string; label?: string; identifier?: string; timeout?: number }) => {
    const spec = buildWaitParams(opts);
    if (!spec.ok) {
      console.error(spec.error);
      process.exit(1);
    }
    await withClient(async (client) => {
      const params: Record<string, unknown> = { ...spec.params };
      // duration-only waits don't need a target pid
      if (params.duration_ms == null) params.pid = await resolveTargetPid(client, opts, { verb: 'wait' });
      const res = unwrap(await client.call('wait', params));
      emit(res, Boolean(opts.json), () =>
        res.satisfied ? `satisfied (${res.waited_ms}ms)` : `timed out (${res.waited_ms}ms)`,
      );
    });
  });

  // get-text — read text without OCR
  addTargetOpts(
    program
      .command('get-text')
      .description('Extract visible text from the app (or a subtree via --id)')
      .option('--id <@eN>', 'Element id from `describe` to scope the extraction')
      .option('--max-chars <n>', 'Cap the extracted text length', (v) => parseInt(v, 10))
      .option('--json', 'Emit JSON'),
  ).action(async (opts: TargetOpts & { id?: string; maxChars?: number }) => {
    await withClient(async (client) => {
      const pid = await resolveTargetPid(client, opts, { verb: 'get-text' });
      const params: Record<string, unknown> = { pid };
      if (opts.id) params.element_id = opts.id;
      if (opts.maxChars != null) params.max_chars = opts.maxChars;
      const res = unwrap(await client.call('get_text', params));
      emit(res, Boolean(opts.json), () => String(res.text ?? ''));
    });
  });

  // launch — start an app (no target resolution: it isn't running yet)
  program
    .command('launch')
    .description('Launch an app by bundle id, path, or name')
    .option('--bundle <id>', 'Bundle id (e.g. com.apple.TextEdit)')
    .option('--path <p>', 'Path to the .app bundle')
    .option('--name <s>', 'App name (resolved via /Applications and LaunchServices)')
    .option('--host <device>', 'Drive a remote Windows device (requires `agents computer start --host <device>` first)')
    .option('--json', 'Emit JSON')
    .action(async (opts: { bundle?: string; path?: string; name?: string; host?: string; json?: boolean }) => {
      if (!opts.bundle && !opts.path && !opts.name) {
        console.error('pass one of --bundle, --path, --name');
        process.exit(1);
      }
      await withClient(async (client) => {
        const params: Record<string, unknown> = {};
        if (opts.bundle) params.bundle_id = opts.bundle;
        if (opts.path) params.path = opts.path;
        if (opts.name) params.name = opts.name;
        const res = unwrap(await client.call('launch_app', params));
        emit(res, Boolean(opts.json), () => `launched ${res.name} (pid ${res.pid})`);
      });
    });
}
