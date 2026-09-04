// RFB (VNC) transport for `agents computer` — drive a remote GUI desktop over
// the RFB protocol instead of a native Accessibility/UIA daemon.
//
// This is the third computer backend, sitting behind the same ComputerClient
// interface as the macOS Unix-socket helper and the Windows TCP helper. It
// speaks RFB 3.8 directly to an x11vnc/Xvnc server (e.g. a headless Linux
// desktop, or an LXD container exposing x11vnc on the host's Tailscale IP), so
// no per-box native helper install is needed — the display is driven over the
// same VNC stream a human would watch.
//
// It is COORDINATE-BASED: RFB carries a framebuffer and pointer/key events, not
// an accessibility tree. So it implements the observe verb `screenshot` and the
// interact verbs `click`/`right-click`/`type`/`type-text`/`key`/`scroll`/`wait`;
// the AX-tree verbs (`describe`/`get-text`/`ax-action`/element-id targeting) and
// app lifecycle (`launch`/`apps` beyond the synthetic desktop target) have no RFB
// equivalent and FAIL LOUD with a clear message rather than a silent no-op.
//
// Wire format note: unlike the JSON-RPC transports, there is no line-delimited
// RPC on the wire here — `call(method, params)` translates a computer RPC verb
// into RFB protocol messages and shapes the reply to match what the command
// layer expects from the native helpers (e.g. screenshot -> { image_data, width,
// height }).

import { createConnection, type Socket } from 'net';
import { deflateSync, crc32 } from 'zlib';
import { desEncryptBlock } from './des.js';
import type { ComputerClient, RPCResponse } from './computer-rpc.js';

// ---------------------------------------------------------------------------
// Pure protocol helpers (exported for unit tests — no socket needed)
// ---------------------------------------------------------------------------

// VNC DES auth mangles the key by reversing the bit order of each byte. This is
// a historical quirk of the reference implementation, not real DES.
export function mirrorByte(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
  return r & 0xff;
}

// Compute the 16-byte VNC-auth response: DES-ECB encrypt the server's 16-byte
// challenge with the (bit-mirrored, 8-byte, null-padded) password as the key.
export function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  if (challenge.length !== 16) throw new Error(`vnc challenge must be 16 bytes, got ${challenge.length}`);
  const key = Buffer.alloc(8, 0);
  const pw = Buffer.from(password, 'latin1');
  for (let i = 0; i < 8 && i < pw.length; i++) key[i] = mirrorByte(pw[i]);
  // VNC encrypts the two 8-byte halves of the challenge as independent ECB
  // blocks under the same key.
  return Buffer.concat([
    desEncryptBlock(key, challenge.subarray(0, 8)),
    desEncryptBlock(key, challenge.subarray(8, 16)),
  ]);
}

// 32bpp true-color, little-endian, R@16 G@8 B@0 — so a pixel's 4 wire bytes are
// [B, G, R, x] and RGB extraction is buf[i+2], buf[i+1], buf[i].
export function buildPixelFormat(): Buffer {
  const pf = Buffer.alloc(16, 0);
  pf[0] = 32; // bits-per-pixel
  pf[1] = 24; // depth
  pf[2] = 0; // big-endian-flag (little-endian)
  pf[3] = 1; // true-color-flag
  pf.writeUInt16BE(255, 4); // red-max
  pf.writeUInt16BE(255, 6); // green-max
  pf.writeUInt16BE(255, 8); // blue-max
  pf[10] = 16; // red-shift
  pf[11] = 8; // green-shift
  pf[12] = 0; // blue-shift
  return pf;
}

export function encodeSetPixelFormat(pf: Buffer): Buffer {
  const msg = Buffer.alloc(4 + 16);
  msg[0] = 0; // SetPixelFormat
  pf.copy(msg, 4);
  return msg;
}

export function encodeSetEncodings(encodings: number[]): Buffer {
  const msg = Buffer.alloc(4 + encodings.length * 4);
  msg[0] = 2; // SetEncodings
  msg.writeUInt16BE(encodings.length, 2);
  encodings.forEach((e, i) => msg.writeInt32BE(e, 4 + i * 4));
  return msg;
}

export function encodeFbUpdateRequest(incremental: boolean, x: number, y: number, w: number, h: number): Buffer {
  const msg = Buffer.alloc(10);
  msg[0] = 3; // FramebufferUpdateRequest
  msg[1] = incremental ? 1 : 0;
  msg.writeUInt16BE(x, 2);
  msg.writeUInt16BE(y, 4);
  msg.writeUInt16BE(w, 6);
  msg.writeUInt16BE(h, 8);
  return msg;
}

export function encodePointerEvent(buttonMask: number, x: number, y: number): Buffer {
  const msg = Buffer.alloc(6);
  msg[0] = 5; // PointerEvent
  msg[1] = buttonMask & 0xff;
  msg.writeUInt16BE(Math.max(0, Math.round(x)), 2);
  msg.writeUInt16BE(Math.max(0, Math.round(y)), 4);
  return msg;
}

export function encodeKeyEvent(down: boolean, keysym: number): Buffer {
  const msg = Buffer.alloc(8);
  msg[0] = 4; // KeyEvent
  msg[1] = down ? 1 : 0;
  msg.writeUInt32BE(keysym >>> 0, 4);
  return msg;
}

// X11 keysyms for the named keys an agent actually presses.
const NAMED_KEYSYMS: Record<string, number> = {
  return: 0xff0d, enter: 0xff0d, tab: 0xff09, escape: 0xff1b, esc: 0xff1b,
  backspace: 0xff08, delete: 0xffff, del: 0xffff, space: 0x0020,
  home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, insert: 0xff63,
  f1: 0xffbe, f2: 0xffbf, f3: 0xffc0, f4: 0xffc1, f5: 0xffc2, f6: 0xffc3,
  f7: 0xffc4, f8: 0xffc5, f9: 0xffc6, f10: 0xffc7, f11: 0xffc8, f12: 0xffc9,
};

const MODIFIER_KEYSYMS: Record<string, number> = {
  shift: 0xffe1, ctrl: 0xffe3, control: 0xffe3,
  alt: 0xffe9, option: 0xffe9, opt: 0xffe9,
  cmd: 0xffeb, command: 0xffeb, super: 0xffeb, meta: 0xffeb, win: 0xffeb,
};

// A single printable character -> its keysym. Latin-1 maps 1:1; anything else
// uses the Unicode-plane keysym (0x01000000 + codepoint).
export function keysymForChar(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x20 && cp <= 0xff) return cp;
  return 0x01000000 + cp;
}

export function keysymForKeyName(name: string): number | null {
  const k = name.trim().toLowerCase();
  if (k in NAMED_KEYSYMS) return NAMED_KEYSYMS[k];
  if ([...name].length === 1) return keysymForChar(name);
  return null;
}

// Parse "ctrl+a" / "cmd+shift+t" / "Return" into modifier keysyms + a key keysym.
export function parseKeyCombo(combo: string): { modifiers: number[]; key: number } {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`empty key combo: "${combo}"`);
  const keyPart = parts[parts.length - 1];
  const modParts = parts.slice(0, -1);
  const modifiers: number[] = [];
  for (const m of modParts) {
    const ks = MODIFIER_KEYSYMS[m.toLowerCase()];
    if (ks == null) throw new Error(`unknown modifier "${m}" in "${combo}"`);
    modifiers.push(ks);
  }
  const key = keysymForKeyName(keyPart);
  if (key == null) throw new Error(`unknown key "${keyPart}" in "${combo}"`);
  return { modifiers, key };
}

// Minimal PNG encoder (color-type 2, RGB, 8-bit, no interlace). rgb is
// width*height*3 bytes, row-major. Uses zlib for IDAT and zlib.crc32 for chunk
// CRCs — no external dependency, deterministic, unit-testable.
export function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const stride = width * 3;
  // Prepend a per-scanline filter byte (0 = none).
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export interface ServerInit {
  width: number;
  height: number;
  name: string;
}

// Map scroll deltas to VNC wheel buttons. The `--dy` contract is "negative =
// down" (honored by the macOS CGEvent and Windows MOUSEEVENTF_WHEEL backends by
// passing dy straight through); `--dx` negative = left. RFB/X11 wheel buttons:
// 4 = up, 5 = down, 6 = left, 7 = right. Pure + unit-tested so the direction
// contract can't silently invert (it did, pre-review).
export function scrollButtonsFor(dx: number, dy: number): { vButton: number; hButton: number } {
  return {
    vButton: dy < 0 ? 5 : dy > 0 ? 4 : 0,
    hButton: dx < 0 ? 6 : dx > 0 ? 7 : 0,
  };
}

// Guard on any length-prefixed string the server frames (name, failure reason,
// ServerCutText). A broken/hostile server sending a huge length would otherwise
// make us wait indefinitely for bytes that never come; fail loud instead.
export const MAX_RFB_STRING_LEN = 1 << 20; // 1 MiB

// ---------------------------------------------------------------------------
// Async socket reader — serve exact-length reads off a streamed connection.
// ---------------------------------------------------------------------------
class ByteReader {
  private buf = Buffer.alloc(0);
  private want: { n: number; resolve: (b: Buffer) => void } | null = null;
  private error: Error | null = null;

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.pump();
  }

  fail(err: Error): void {
    this.error = err;
    if (this.want) {
      const w = this.want;
      this.want = null;
      // Reject via a sentinel-length read; the awaiting read() rejects below.
      w.resolve(Buffer.alloc(0));
    }
  }

  private pump(): void {
    if (this.want && this.buf.length >= this.want.n) {
      const { n, resolve } = this.want;
      this.want = null;
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      resolve(out);
    }
  }

  read(n: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.want = {
        n,
        resolve: (b) => {
          if (this.error) reject(this.error);
          else resolve(b);
        },
      };
      this.pump();
    });
  }
}

export function parseVncEndpoint(raw: string | undefined): { host: string; port: number } | null {
  if (!raw || raw.length === 0) return null;
  const idx = raw.lastIndexOf(':');
  const host = idx >= 0 ? raw.slice(0, idx) : raw;
  const portStr = idx >= 0 ? raw.slice(idx + 1) : '5901';
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: host || '127.0.0.1', port };
}

const RPC_TIMEOUT_MS = 30_000;

// The one synthetic target the VNC backend exposes: the whole desktop. Lets the
// screenshot command's list_apps->pickTarget->pid flow resolve without change
// (`active: true` is what pickTarget's frontmost-app default selects).
const DESKTOP_APP = { pid: 1, bundle_id: 'desktop', name: 'Desktop', active: true };

export class RfbClient implements ComputerClient {
  private sock: Socket | null = null;
  private reader = new ByteReader();
  private ready: Promise<ServerInit>;
  private info: ServerInit | null = null;
  private closed = false;

  constructor(private host: string, private port: number, private password: string) {
    this.ready = this.handshake();
  }

  private write(b: Buffer): void {
    if (!this.sock) throw new Error('vnc socket not connected');
    this.sock.write(b);
  }

  // Read a U32-length-prefixed latin1 string, capped so a bogus length can't
  // wedge us waiting for bytes that never arrive.
  private async readLenString(what: string): Promise<string> {
    const len = (await this.reader.read(4)).readUInt32BE(0);
    if (len > MAX_RFB_STRING_LEN) throw new Error(`vnc ${what} length ${len} exceeds ${MAX_RFB_STRING_LEN}`);
    return (await this.reader.read(len)).toString('latin1');
  }

  private async handshake(): Promise<ServerInit> {
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host: this.host, port: this.port }, () => resolve());
      sock.on('data', (c: Buffer) => this.reader.push(c));
      sock.on('error', (e) => {
        this.closed = true;
        this.reader.fail(e);
        reject(e);
      });
      sock.on('close', () => {
        this.closed = true;
        this.reader.fail(new Error('vnc connection closed'));
      });
      this.sock = sock;
    });

    // 1. ProtocolVersion: server sends "RFB 003.00x\n", we answer 3.8.
    const serverVersion = (await this.reader.read(12)).toString('latin1');
    if (!serverVersion.startsWith('RFB ')) throw new Error(`not an RFB server (got "${serverVersion.trim()}")`);
    this.write(Buffer.from('RFB 003.008\n', 'latin1'));

    // 2. Security types (3.7+): count, then that many U8 types.
    const nTypes = (await this.reader.read(1))[0];
    if (nTypes === 0) {
      const reason = await this.readLenString('failure reason');
      throw new Error(`vnc server refused connection: ${reason}`);
    }
    const types = [...(await this.reader.read(nTypes))];
    // Prefer VNC auth (2); accept None (1).
    let chosen: number;
    if (types.includes(2)) chosen = 2;
    else if (types.includes(1)) chosen = 1;
    else throw new Error(`no supported vnc security type (server offered ${types.join(',')})`);
    this.write(Buffer.from([chosen]));

    if (chosen === 2) {
      const challenge = await this.reader.read(16);
      if (!this.password) throw new Error('vnc server requires a password; set COMPUTER_HELPER_VNC_PASSWORD or --vnc-password');
      const response = vncAuthResponse(challenge, this.password);
      this.write(response);
    }

    // 3. SecurityResult (always present in 3.8).
    const result = (await this.reader.read(4)).readUInt32BE(0);
    if (result !== 0) {
      // 3.8 sends a reason string on failure.
      let reason = 'authentication failed';
      try {
        reason = await this.readLenString('auth failure reason');
      } catch { /* some servers just drop the connection instead */ }
      throw new Error(`vnc auth failed: ${reason}`);
    }

    // 4. ClientInit (shared = 1) -> ServerInit.
    this.write(Buffer.from([1]));
    const head = await this.reader.read(4 + 16 + 4);
    const width = head.readUInt16BE(0);
    const height = head.readUInt16BE(2);
    const nameLen = head.readUInt32BE(20);
    if (nameLen > MAX_RFB_STRING_LEN) throw new Error(`vnc desktop name length ${nameLen} exceeds ${MAX_RFB_STRING_LEN}`);
    const name = (await this.reader.read(nameLen)).toString('latin1');

    // Pin our pixel format + advertise only Raw so decode is simple + correct.
    this.write(encodeSetPixelFormat(buildPixelFormat()));
    this.write(encodeSetEncodings([0]));

    this.info = { width, height, name };
    return this.info;
  }

  // Tear the connection down for good: reject any pending read, destroy the
  // socket, and mark closed so every later call fails loud. Idempotent.
  private teardown(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.fail(new Error(message));
    this.sock?.destroy();
  }

  // A timed-out RFB read cannot be recovered: the awaited bytes may still land
  // later and would be misread as the NEXT request's reply, permanently
  // desyncing the stream. So a timeout tears the whole connection down rather
  // than leaving a pending read for the next call to silently overwrite.
  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const msg = `vnc ${label} timed out after ${RPC_TIMEOUT_MS}ms`;
        this.teardown(msg);
        reject(new Error(msg));
      }, RPC_TIMEOUT_MS);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  // Request the full framebuffer and assemble it into an RGB buffer, then PNG.
  private async captureScreen(): Promise<{ image_data: string; width: number; height: number }> {
    const info = this.info!;
    this.write(encodeFbUpdateRequest(false, 0, 0, info.width, info.height));

    const rgb = Buffer.alloc(info.width * info.height * 3);
    // Read messages until a FramebufferUpdate covering the frame is assembled.
    // We requested a single non-incremental full-frame update, so one
    // FramebufferUpdate message carries all rectangles.
    for (;;) {
      const msgType = (await this.reader.read(1))[0];
      if (msgType === 0) {
        await this.reader.read(1); // padding
        const nRects = (await this.reader.read(2)).readUInt16BE(0);
        for (let r = 0; r < nRects; r++) {
          const rh = await this.reader.read(12);
          const rx = rh.readUInt16BE(0);
          const ry = rh.readUInt16BE(2);
          const rw = rh.readUInt16BE(4);
          const rHt = rh.readUInt16BE(6);
          const enc = rh.readInt32BE(8);
          if (enc !== 0) throw new Error(`vnc server used unsupported encoding ${enc} (only Raw was advertised)`);
          const pixels = await this.reader.read(rw * rHt * 4);
          for (let y = 0; y < rHt; y++) {
            for (let x = 0; x < rw; x++) {
              const src = (y * rw + x) * 4;
              const dstX = rx + x;
              const dstY = ry + y;
              if (dstX >= info.width || dstY >= info.height) continue;
              const dst = (dstY * info.width + dstX) * 3;
              rgb[dst] = pixels[src + 2]; // R
              rgb[dst + 1] = pixels[src + 1]; // G
              rgb[dst + 2] = pixels[src]; // B
            }
          }
        }
        break;
      } else if (msgType === 2) {
        // Bell — no body.
      } else if (msgType === 3) {
        // ServerCutText: 3 padding + U32 length + text (discarded).
        await this.reader.read(3);
        await this.readLenString('server cut text');
      } else {
        throw new Error(`unexpected vnc server message type ${msgType}`);
      }
    }
    return { image_data: encodePng(rgb, info.width, info.height).toString('base64'), width: info.width, height: info.height };
  }

  private sendClick(x: number, y: number, button: number, count: number): void {
    const mask = 1 << (button - 1);
    for (let i = 0; i < Math.max(1, count); i++) {
      this.write(encodePointerEvent(0, x, y)); // move
      this.write(encodePointerEvent(mask, x, y)); // press
      this.write(encodePointerEvent(0, x, y)); // release
    }
  }

  private sendScroll(x: number, y: number, dx: number, dy: number, count: number): void {
    const notches = Math.max(1, count || Math.max(Math.abs(dx), Math.abs(dy)) || 1);
    const { vButton, hButton } = scrollButtonsFor(dx, dy);
    for (const button of [vButton, hButton]) {
      if (!button) continue;
      const mask = 1 << (button - 1);
      for (let i = 0; i < notches; i++) {
        this.write(encodePointerEvent(mask, x, y));
        this.write(encodePointerEvent(0, x, y));
      }
    }
  }

  private typeText(text: string): void {
    for (const ch of text) {
      const ks = keysymForChar(ch);
      this.write(encodeKeyEvent(true, ks));
      this.write(encodeKeyEvent(false, ks));
    }
  }

  private pressCombo(combo: string): void {
    const { modifiers, key } = parseKeyCombo(combo);
    for (const m of modifiers) this.write(encodeKeyEvent(true, m));
    this.write(encodeKeyEvent(true, key));
    this.write(encodeKeyEvent(false, key));
    for (const m of [...modifiers].reverse()) this.write(encodeKeyEvent(false, m));
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<RPCResponse> {
    if (this.closed) return { id: null, error: { code: 'vnc_closed', message: 'vnc connection closed' } };
    try {
      await this.withTimeout(this.ready, 'handshake');
      const x = Number(params.x ?? 0);
      const y = Number(params.y ?? 0);
      switch (method) {
        case 'list_apps':
          return { id: null, result: { apps: [DESKTOP_APP] } };
        case 'screenshot': {
          if (params.list) return { id: null, result: { windows: [] } };
          const shot = await this.withTimeout(this.captureScreen(), 'screenshot');
          return { id: null, result: shot };
        }
        case 'click':
          this.sendClick(x, y, 1, Number(params.count ?? 1));
          return { id: null, result: { ok: true } };
        case 'right_click':
          this.sendClick(x, y, 3, Number(params.count ?? 1));
          return { id: null, result: { ok: true } };
        case 'scroll':
          this.sendScroll(x, y, Number(params.dx ?? 0), Number(params.dy ?? 0), Number(params.count ?? 0));
          return { id: null, result: { ok: true } };
        case 'type': {
          if (params.x != null && params.y != null) this.sendClick(x, y, 1, 1);
          if (params.text != null) this.typeText(String(params.text));
          if (params.commit) this.pressCombo('Return');
          return { id: null, result: { ok: true } };
        }
        case 'type_text':
          if (params.text != null) this.typeText(String(params.text));
          if (params.commit) this.pressCombo('Return');
          return { id: null, result: { ok: true } };
        case 'key':
          for (const combo of String(params.keys ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
            this.pressCombo(combo);
          }
          return { id: null, result: { ok: true } };
        case 'focus_window':
        case 'set_focus':
          // No window manager control over RFB; the desktop is the target.
          return { id: null, result: { ok: true } };
        case 'wait': {
          const ms = Number(params.duration_ms ?? 0);
          if (ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, RPC_TIMEOUT_MS)));
          return { id: null, result: { ok: true } };
        }
        case 'describe':
        case 'get_text':
        case 'ax_action':
          return { id: null, error: { code: 'unsupported_over_vnc', message: `'${method}' needs an accessibility tree; the VNC backend is coordinate-based. Use screenshot + click/type by coordinate.` } };
        case 'launch_app':
          return { id: null, error: { code: 'unsupported_over_vnc', message: 'launch is not available over VNC; open the app from the desktop UI with click/type.' } };
        default:
          return { id: null, error: { code: 'unknown_method', message: `vnc backend has no method '${method}'` } };
      }
    } catch (e) {
      return { id: null, error: { code: 'vnc_error', message: (e as Error).message } };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sock = this.sock;
    if (!sock) return;
    sock.end();
    // Await real teardown (like TcpClient.close), but never hang on it.
    await new Promise<void>((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      sock.once('close', fin);
      setTimeout(fin, 2000);
    });
  }
}
