// Live RFB/VNC end-to-end test. Drives a REAL x11vnc/Xvnc desktop: connect,
// screenshot (assert a real PNG of the framebuffer size), and send input.
// Gated on AGENTS_TEST_VNC=<host:port> (+ AGENTS_TEST_VNC_PASSWORD) so CI needs
// no VNC server — it skips cleanly when the var is unset, mirroring the Windows
// ssh.e2e.test.ts / ssh-tunnel.e2e.test.ts gating.
//
//   AGENTS_TEST_VNC=100.x.y.z:5901 AGENTS_TEST_VNC_PASSWORD=prix2026 \
//     bun run test src/lib/computer/rfb-client.e2e.test.ts
import { describe, it, expect } from 'vitest';
import { RfbClient, parseVncEndpoint } from './rfb-client.js';

const endpoint = parseVncEndpoint(process.env.AGENTS_TEST_VNC);
const password = process.env.AGENTS_TEST_VNC_PASSWORD ?? '';

describe.skipIf(!endpoint)('RfbClient (live VNC)', () => {
  it('captures a PNG framebuffer and accepts input', async () => {
    const client = new RfbClient(endpoint!.host, endpoint!.port, password);
    try {
      const shot = await client.call('screenshot', {});
      expect(shot.error).toBeUndefined();
      const b64 = shot.result?.image_data as string;
      expect(typeof b64).toBe('string');
      const buf = Buffer.from(b64, 'base64');
      // Real PNG signature.
      expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const width = shot.result?.width as number;
      const height = shot.result?.height as number;
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      // The PNG's IHDR dimensions match the reported framebuffer.
      expect(buf.readUInt32BE(16)).toBe(width);
      expect(buf.readUInt32BE(20)).toBe(height);

      // Input verbs return ok (no accessibility tree needed).
      expect((await client.call('click', { x: 10, y: 10 })).error).toBeUndefined();
      expect((await client.call('key', { keys: 'Escape' })).error).toBeUndefined();
      expect((await client.call('scroll', { x: 400, y: 400, dy: -3 })).error).toBeUndefined();

      // An AX-only verb fails loud rather than silently no-op'ing.
      const describe = await client.call('describe', {});
      expect(describe.error?.code).toBe('unsupported_over_vnc');
    } finally {
      await client.close();
    }
  }, 30_000);
});
