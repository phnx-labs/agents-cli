import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeWebhookServer } from './webhook.js';

describe('closeWebhookServer (PHNX-3943)', () => {
  it('closes promptly and destroys a real HTTP keep-alive socket', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((_request, response) => {
      response.end('ok');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const agent = new http.Agent({ keepAlive: true });
    let clientSocket: import('node:net').Socket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, agent }, (response) => {
          response.resume();
          response.once('end', resolve);
        });
        request.once('socket', (socket) => { clientSocket = socket; });
        request.once('error', reject);
      });
      expect(clientSocket?.destroyed).toBe(false);

      const socket = clientSocket!;
      const clientClosed = new Promise<void>((resolve) => socket.once('close', resolve));
      await Promise.race([
        Promise.all([closeWebhookServer(server, sockets), clientClosed]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown exceeded 500ms')), 500)),
      ]);

      expect(socket.destroyed).toBe(true);
    } finally {
      agent.destroy();
      await closeWebhookServer(server, sockets);
    }
  });
});
