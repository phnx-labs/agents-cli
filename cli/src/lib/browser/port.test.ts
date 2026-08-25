import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { allocatePort, getPortOccupant } from './chrome.js';

describe('port inspection', () => {
  it('getPortOccupant detects a real listener', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const occ = getPortOccupant(port);
      expect(occ).not.toBeNull();
      expect(occ!.pid).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('allocatePort returns a free port in [9200, 9300)', () => {
    const p = allocatePort();
    expect(p).toBeGreaterThanOrEqual(9200);
    expect(p).toBeLessThan(9300);
  });
});
