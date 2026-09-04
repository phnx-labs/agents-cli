import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import {
  mirrorByte,
  vncAuthResponse,
  buildPixelFormat,
  encodeSetPixelFormat,
  encodeSetEncodings,
  encodeFbUpdateRequest,
  encodePointerEvent,
  encodeKeyEvent,
  keysymForChar,
  keysymForKeyName,
  parseKeyCombo,
  encodePng,
  parseVncEndpoint,
  scrollButtonsFor,
} from './rfb-client.js';

describe('mirrorByte', () => {
  it('reverses bit order within a byte', () => {
    expect(mirrorByte(0x01)).toBe(0x80);
    expect(mirrorByte(0x80)).toBe(0x01);
    expect(mirrorByte(0x02)).toBe(0x40);
    expect(mirrorByte(0xff)).toBe(0xff);
    expect(mirrorByte(0x00)).toBe(0x00);
    expect(mirrorByte(0xa5)).toBe(0xa5); // 1010_0101 is a palindrome
  });
});

describe('vncAuthResponse', () => {
  it('produces a 16-byte deterministic response keyed by the password', () => {
    const challenge = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const a = vncAuthResponse(challenge, 'secret12');
    const b = vncAuthResponse(challenge, 'secret12');
    expect(a.length).toBe(16);
    expect(a.equals(b)).toBe(true); // deterministic
    expect(vncAuthResponse(challenge, 'other').equals(a)).toBe(false); // password-keyed
  });

  it('truncates the password to 8 bytes (VNC only uses the first 8)', () => {
    const challenge = Buffer.alloc(16, 7);
    expect(vncAuthResponse(challenge, 'abcdefgh').equals(vncAuthResponse(challenge, 'abcdefghIJKL'))).toBe(true);
  });

  it('rejects a wrong-length challenge', () => {
    expect(() => vncAuthResponse(Buffer.alloc(8), 'pw')).toThrow(/16 bytes/);
  });
});

describe('buildPixelFormat', () => {
  it('describes 32bpp little-endian true-color RGB', () => {
    const pf = buildPixelFormat();
    expect(pf.length).toBe(16);
    expect(pf[0]).toBe(32); // bpp
    expect(pf[1]).toBe(24); // depth
    expect(pf[2]).toBe(0); // little-endian
    expect(pf[3]).toBe(1); // true-color
    expect(pf.readUInt16BE(4)).toBe(255); // red-max
    expect(pf[10]).toBe(16); // red-shift
    expect(pf[11]).toBe(8); // green-shift
    expect(pf[12]).toBe(0); // blue-shift
  });
});

describe('message encoders', () => {
  it('SetPixelFormat is type 0 + 3 pad + 16-byte format', () => {
    const m = encodeSetPixelFormat(buildPixelFormat());
    expect(m.length).toBe(20);
    expect(m[0]).toBe(0);
    expect(m[4]).toBe(32);
  });

  it('SetEncodings lists the advertised encodings', () => {
    const m = encodeSetEncodings([0]);
    expect(m[0]).toBe(2);
    expect(m.readUInt16BE(2)).toBe(1);
    expect(m.readInt32BE(4)).toBe(0); // Raw
  });

  it('FramebufferUpdateRequest carries the rect + incremental flag', () => {
    const m = encodeFbUpdateRequest(false, 0, 0, 1600, 900);
    expect(m[0]).toBe(3);
    expect(m[1]).toBe(0); // non-incremental
    expect(m.readUInt16BE(6)).toBe(1600);
    expect(m.readUInt16BE(8)).toBe(900);
  });

  it('PointerEvent carries mask + rounded coords', () => {
    const m = encodePointerEvent(0b1, 123.6, 45.2);
    expect(m[0]).toBe(5);
    expect(m[1]).toBe(1);
    expect(m.readUInt16BE(2)).toBe(124);
    expect(m.readUInt16BE(4)).toBe(45);
  });

  it('KeyEvent carries the down flag + keysym', () => {
    const down = encodeKeyEvent(true, 0xff0d);
    expect(down[0]).toBe(4);
    expect(down[1]).toBe(1);
    expect(down.readUInt32BE(4)).toBe(0xff0d);
    expect(encodeKeyEvent(false, 0xff0d)[1]).toBe(0);
  });
});

describe('keysyms', () => {
  it('maps printable characters to their code point', () => {
    expect(keysymForChar('a')).toBe(0x61);
    expect(keysymForChar('A')).toBe(0x41);
    expect(keysymForChar(' ')).toBe(0x20);
    expect(keysymForChar('é')).toBe(0xe9); // Latin-1
    expect(keysymForChar('€')).toBe(0x01000000 + 0x20ac); // Unicode plane
  });

  it('maps named keys, single chars, and rejects unknowns', () => {
    expect(keysymForKeyName('Return')).toBe(0xff0d);
    expect(keysymForKeyName('tab')).toBe(0xff09);
    expect(keysymForKeyName('F5')).toBe(0xffc2);
    expect(keysymForKeyName('x')).toBe(0x78);
    expect(keysymForKeyName('nope')).toBeNull();
  });

  it('parses modifier combos', () => {
    expect(parseKeyCombo('ctrl+a')).toEqual({ modifiers: [0xffe3], key: 0x61 });
    expect(parseKeyCombo('cmd+shift+t')).toEqual({ modifiers: [0xffeb, 0xffe1], key: 0x74 });
    expect(parseKeyCombo('Return')).toEqual({ modifiers: [], key: 0xff0d });
    expect(() => parseKeyCombo('bogus+a')).toThrow(/unknown modifier/);
    expect(() => parseKeyCombo('ctrl+nope')).toThrow(/unknown key/);
  });
});

describe('encodePng', () => {
  it('emits a valid PNG whose IDAT inflates to filtered RGB scanlines', () => {
    const w = 3;
    const h = 2;
    const rgb = Buffer.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255, // row 0: R G B
      1, 2, 3, 4, 5, 6, 7, 8, 9, // row 1
    ]);
    const png = encodePng(rgb, w, h);
    // Signature
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR chunk starts at offset 8: len(4) type(4) then data
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(w);
    expect(png.readUInt32BE(20)).toBe(h);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(2); // color type RGB
    // Find IDAT, inflate, check it's filter-byte-prefixed scanlines.
    const idatIdx = png.indexOf(Buffer.from('IDAT', 'latin1'));
    const idatLen = png.readUInt32BE(idatIdx - 4);
    const idat = png.subarray(idatIdx + 4, idatIdx + 4 + idatLen);
    const raw = inflateSync(idat);
    expect(raw.length).toBe(h * (w * 3 + 1));
    expect(raw[0]).toBe(0); // row 0 filter byte
    expect([...raw.subarray(1, 4)]).toEqual([255, 0, 0]);
  });
});

describe('scrollButtonsFor', () => {
  it('maps deltas to the correct VNC wheel buttons (contract: -dy = down, -dx = left)', () => {
    // The bug this pins: dy<0 must be DOWN (button 5), not up.
    expect(scrollButtonsFor(0, -3)).toEqual({ vButton: 5, hButton: 0 }); // down
    expect(scrollButtonsFor(0, 3)).toEqual({ vButton: 4, hButton: 0 }); // up
    expect(scrollButtonsFor(-3, 0)).toEqual({ vButton: 0, hButton: 6 }); // left
    expect(scrollButtonsFor(3, 0)).toEqual({ vButton: 0, hButton: 7 }); // right
    expect(scrollButtonsFor(0, 0)).toEqual({ vButton: 0, hButton: 0 });
  });
});

describe('parseVncEndpoint', () => {
  it('parses host:port and defaults the port to 5901', () => {
    expect(parseVncEndpoint('100.74.242.106:5901')).toEqual({ host: '100.74.242.106', port: 5901 });
    expect(parseVncEndpoint('yosemite-m1')).toEqual({ host: 'yosemite-m1', port: 5901 });
    expect(parseVncEndpoint('box:5902')).toEqual({ host: 'box', port: 5902 });
  });

  it('returns null for empty or invalid input', () => {
    expect(parseVncEndpoint(undefined)).toBeNull();
    expect(parseVncEndpoint('')).toBeNull();
    expect(parseVncEndpoint('host:notaport')).toBeNull();
    expect(parseVncEndpoint('host:99999')).toBeNull();
  });
});
