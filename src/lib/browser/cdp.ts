type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type EventHandler = (params: Record<string, unknown>) => void;

export class CDPClient {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pending = new Map<number, PendingCall>();
  private eventHandlers = new Map<string, Set<EventHandler>>();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => resolve();
      this.ws.onerror = (ev) => reject(new Error('WebSocket error'));
      this.ws.onclose = () => this.handleClose();
      this.ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    });
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Reached when the underlying browser was killed externally between
      // the daemon establishing the connection and a CDP call going out.
      // The service-layer healthcheck normally catches this on the next
      // `start`, so seeing this in the wild means a request landed against
      // an in-flight conn that just died — tell the user how to recover.
      throw new Error(
        'CDP connection not open — the browser was likely closed externally. ' +
          'Run `agents browser stop --profile <name>` (or restart the daemon) and try again.'
      );
    }

    const id = ++this.messageId;
    const message = sessionId
      ? JSON.stringify({ id, method, params, sessionId })
      : JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.ws!.send(message);
    });
  }

  on(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get isOpen(): boolean {
    return this.connected;
  }

  private handleMessage(data: string): void {
    const msg = JSON.parse(data);

    if ('id' in msg) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if ('error' in msg) {
          pending.reject(new Error(msg.error.message || 'CDP error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if ('method' in msg) {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params || {});
        }
      }
    }
  }

  private handleClose(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.ws = null;
  }
}

export interface BrowserDiscovery {
  wsUrl: string;
  browser: string;
}

export async function discoverBrowserWsUrl(
  port: number,
  host = 'localhost'
): Promise<BrowserDiscovery> {
  const response = await fetch(`http://${host}:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`Failed to discover browser: ${response.status}`);
  }
  const data = (await response.json()) as {
    webSocketDebuggerUrl: string;
    Browser?: string;
    Product?: string;
  };
  const browserField = data.Browser || data.Product || '';
  return {
    wsUrl: data.webSocketDebuggerUrl,
    browser: normalizeBrowserName(browserField),
  };
}

export function normalizeBrowserName(s: string): string {
  if (!s) return 'unknown';
  return s.split('/')[0].trim().toLowerCase().replace(/\s+/g, '-');
}

export function verifyBrowserIdentity(
  reported: string,
  expected: string,
  port: number,
  host = 'localhost'
): void {
  if (expected === 'custom') return;
  if (reported === 'unknown') return;

  const matches: Record<string, string[]> = {
    chrome: ['chrome', 'google-chrome', 'headlesschrome'],
    chromium: ['chromium', 'headlesschrome', 'chrome'],
    // Comet reports itself as plain "Chrome/<version>" in /json/version — it
    // doesn't override the Chromium branding. Accept chrome here so attaching
    // to a Comet instance doesn't trip a false "identity mismatch".
    comet: ['comet', 'chrome'],
    brave: ['brave', 'brave-browser', 'chrome'],
    edge: ['edge', 'microsoft-edge', 'msedge', 'chrome'],
  };

  const accepted = matches[expected] || [expected];
  if (accepted.includes(reported)) return;

  const target = host === 'localhost' || host === '127.0.0.1' ? `port ${port}` : `${host}:${port}`;
  throw new Error(
    `Browser identity mismatch: profile expects "${expected}" but ${target} is serving "${reported}". ` +
      `Stop the running browser (e.g. \`pkill -f ${reported}\`) or update the profile to browser=${reported}, then retry.`
  );
}

export async function listTargets(
  port: number,
  host = 'localhost'
): Promise<Array<{ id: string; type: string; title: string; url: string }>> {
  const response = await fetch(`http://${host}:${port}/json`);
  if (!response.ok) {
    throw new Error(`Failed to list targets: ${response.status}`);
  }
  return response.json() as Promise<Array<{ id: string; type: string; title: string; url: string }>>;
}
