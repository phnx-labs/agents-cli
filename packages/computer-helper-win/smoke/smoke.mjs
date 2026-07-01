// Smoke test for computer-helper-win — exercises the real UIAutomation path on
// Windows. Spawns the built daemon, then over the TCP/JSON-RPC wire:
//   ping -> launch Notepad -> describe (UIAutomation tree walk) -> set_focus ->
//   type_text -> get_text roundtrip -> screenshot.
// Zero dependencies (node net + child_process). Exit 0 = pass, 1 = fail.
//
// Usage: node smoke.mjs --exe <path-to-computer-helper-win.exe> [--port 8765]

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const exe = argVal('--exe');
const port = Number(argVal('--port') ?? 8765);
if (!exe) fail('missing --exe <path>');

function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`  ok: ${msg}`);
}

// ---- JSON-RPC client over one persistent TCP connection -------------------
class Client {
  constructor(sock) {
    this.sock = sock;
    this.buf = '';
    this.waiters = new Map();
    this.nextId = 1;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const w = this.waiters.get(obj.id);
        if (w) { this.waiters.delete(obj.id); w(obj); }
      }
    });
  }
  call(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, 30_000);
      this.waiters.set(id, (obj) => {
        clearTimeout(timer);
        if (obj.error) reject(new Error(`${method} -> ${obj.error.code}: ${obj.error.message}`));
        else resolve(obj.result);
      });
      this.sock.write(payload);
    });
  }
}

function findByRole(node, roles, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.id && roles.includes(node.role)) out.push(node);
  for (const c of node.children ?? []) findByRole(c, roles, out);
  return out;
}
function countNodes(node) {
  if (!node) return 0;
  let n = node.id ? 1 : 0;
  for (const c of node.children ?? []) n += countNodes(c);
  return n;
}
// First node carrying an on-screen [x,y,w,h] rect (DFS) — a target for the
// pointer verbs (drag/right_click/scroll) when the edit control has no bounds.
function firstBounds(node) {
  if (node && Array.isArray(node.bounds)) return node.bounds;
  for (const c of node?.children ?? []) {
    const b = firstBounds(c);
    if (b) return b;
  }
  return null;
}

async function connectWithRetry(p, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const s = connect({ host: '127.0.0.1', port: p }, () => resolve(s));
        s.on('error', reject);
      });
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`could not connect to 127.0.0.1:${p}`);
}

const TYPED = `hello-smoke-${process.pid}`;

async function main() {
  console.log(`spawning daemon: ${exe} --port ${port}`);
  const daemon = spawn(exe, ['--port', String(port)], { stdio: ['ignore', 'inherit', 'inherit'] });
  daemon.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`daemon exited early: ${code}`);
  });

  let sock;
  try {
    sock = await connectWithRetry(port);
    const c = new Client(sock);

    // 1. ping
    const pong = await c.call('ping');
    if (!pong?.pong) fail(`ping did not pong: ${JSON.stringify(pong)}`);
    ok('ping');

    // 2. launch Notepad (classic Win32 notepad on the runner)
    const launched = await c.call('launch_app', { path: 'C:\\Windows\\System32\\notepad.exe' });
    ok(`launch_app -> pid ${launched.pid}`);

    // 3. resolve the notepad pid via list_apps (launch may hand off)
    let pid = launched.pid;
    for (let i = 0; i < 25; i++) {
      const { apps } = await c.call('list_apps');
      const np = apps.find((a) => /notepad/i.test(a.bundle_id ?? '') || /notepad/i.test(a.name ?? ''));
      if (np) { pid = np.pid; break; }
      await sleep(300);
    }
    if (!pid) fail('notepad pid not found via list_apps');
    ok(`notepad pid = ${pid}`);

    // 4. describe — the UIAutomation tree walk
    const desc = await c.call('describe', { pid });
    const total = countNodes(desc.tree);
    if (!(desc.element_count > 0) || total === 0) fail(`describe returned empty tree: ${JSON.stringify(desc).slice(0, 400)}`);
    const withBounds = findByRole(desc.tree, ['Window', 'Edit', 'Document', 'Application']).some((n) => Array.isArray(n.bounds));
    if (!withBounds) fail('no node carried bounds — UIA property read is broken');
    ok(`describe: element_count=${desc.element_count}`);

    // 5. id-addressable roundtrip: focus the editable control, type, read back
    const editable = findByRole(desc.tree, ['Edit', 'Document']);
    if (editable.length === 0) fail(`no Edit/Document element in notepad tree: ${JSON.stringify(desc.tree).slice(0, 600)}`);
    const elId = editable[0].id;
    await c.call('set_focus', { pid, element_id: elId });
    ok(`set_focus ${elId}`);
    await c.call('type_text', { text: TYPED });
    ok(`type_text "${TYPED}"`);
    // SendInput delivers keystrokes to the target's message loop
    // asynchronously, so poll get_text until the document settles.
    let lastText = '';
    let matched = false;
    for (let i = 0; i < 30; i++) {
      const got = await c.call('get_text', { pid, element_id: elId });
      lastText = String(got.text ?? '');
      if (lastText.includes(TYPED)) { matched = true; break; }
      await sleep(150);
    }
    if (!matched) fail(`get_text roundtrip mismatch after retries: got ${JSON.stringify(lastText)}`);
    ok(`get_text roundtrip matched`);

    // 6. screenshot
    const shot = await c.call('screenshot');
    if (!shot.image_data || shot.image_data.length < 1000) fail('screenshot image_data too small');
    const png = Buffer.from(shot.image_data, 'base64');
    if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) fail('screenshot is not a PNG');
    ok(`screenshot ${shot.width}x${shot.height} (${png.length} bytes)`);

    // ---- parity verbs: match the macOS helper's result shapes ----------

    // 7. notify — pure pass-through (no Windows toast API); the manager
    // intercepts the return value.
    const notif = await c.call('notify', { message: TYPED, pid });
    if (notif?.notified !== true || notif.message !== TYPED) fail(`notify wrong shape: ${JSON.stringify(notif)}`);
    if (notif.pid !== pid) fail(`notify did not echo pid: ${JSON.stringify(notif)}`);
    ok('notify pass-through');

    // 8. wait — unconditional duration, then poll the cached edit element.
    const waited = await c.call('wait', { duration_ms: 100 });
    if (waited?.satisfied !== true || typeof waited.waited_ms !== 'number') fail(`wait duration wrong: ${JSON.stringify(waited)}`);
    ok(`wait duration (${waited.waited_ms}ms)`);
    const waitEl = await c.call('wait', { pid, element_id: elId, until: 'exists', timeout_ms: 2000 });
    if (waitEl?.satisfied !== true) fail(`wait element exists not satisfied: ${JSON.stringify(waitEl)}`);
    ok('wait element exists');

    // 9. focus_window — app-level activate (no window_id/title → raised_window false).
    const focused = await c.call('focus_window', { pid });
    if (focused?.ok !== true || typeof focused.focus_elapsed_ms !== 'number' || focused.raised_window !== false) {
      fail(`focus_window wrong shape: ${JSON.stringify(focused)}`);
    }
    ok(`focus_window (${focused.focus_elapsed_ms}ms, was_minimized=${focused.was_minimized})`);

    // 10. scroll — synthesized wheel. Notepad has little to scroll, but the RPC
    // must still succeed with the {ok, method} shape.
    const scrolled = await c.call('scroll', { pid, dy: -3 });
    if (scrolled?.ok !== true || scrolled.method !== 'wheel') fail(`scroll wrong shape: ${JSON.stringify(scrolled)}`);
    ok(`scroll (${scrolled.method})`);

    // A point inside the notepad window for the pointer verbs.
    const bounds = (Array.isArray(editable[0].bounds) && editable[0].bounds) || firstBounds(desc.tree);
    if (!bounds) fail('no bounds available to target pointer verbs');
    const [bx, by, bw, bh] = bounds;
    const cx = bx + Math.floor(bw / 2), cy = by + Math.floor(bh / 2);

    // 11. drag — press → interpolated move → release inside the edit region.
    const dragged = await c.call('drag', { pid, from: [cx, cy], to: [cx + Math.min(40, Math.floor(bw / 4)), cy] });
    if (dragged?.ok !== true || dragged.method !== 'drag') fail(`drag wrong shape: ${JSON.stringify(dragged)}`);
    ok(`drag (${dragged.method})`);

    // 12. right_click — opens the context menu; Escape closes it so the session
    // stays clean for the next run.
    const rclick = await c.call('right_click', { pid, x: cx, y: cy });
    if (rclick?.ok !== true || rclick.method !== 'right_click' || !Array.isArray(rclick.at)) {
      fail(`right_click wrong shape: ${JSON.stringify(rclick)}`);
    }
    await c.call('key', { keys: 'escape' });
    ok(`right_click at [${rclick.at}]`);

    // 13. ax_action — the Edit control advertises no invoke/toggle/select action,
    // so an unknown action must surface action_unsupported with the available list.
    let axErr = null;
    try { await c.call('ax_action', { pid, element_id: elId, action: '__nope__' }); }
    catch (e) { axErr = e; }
    if (!axErr || !/action_unsupported/.test(axErr.message)) fail(`ax_action did not reject unknown action: ${axErr?.message}`);
    ok('ax_action rejects unknown action (action_unsupported)');

    console.log('SMOKE PASS');
  } finally {
    try { sock?.destroy(); } catch {}
    try { daemon.kill(); } catch {}
    // best-effort: close notepad so the runner session is clean
    try { spawn('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' }); } catch {}
  }
}

main().catch((e) => fail(e.message));
