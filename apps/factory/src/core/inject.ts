// Pure decode + target-selection logic for the `swarm-ext://…/inject` URI verb.
// The agents-cli emits `swarm-ext://swarmify.swarm-ext/inject?p=<base64url-json>`
// where the JSON payload is { terminalId, text, enter, combined }. terminalId is
// the CLI session UUID the extension keys its live-terminals registry on.
// I/O (sendText, show, logging) lives in the extension URI handler.

export interface InjectPayload {
  terminalId: string;
  text: string;
  enter: boolean;
  combined: boolean;
}

export interface InjectTerminal {
  id: string;
  sessionId?: string;
}

// Decode the single `p` query param (base64url-encoded JSON) into a validated
// payload. Returns null on any malformed input — the caller logs + returns
// rather than throwing, so a bad URI can never crash the extension host.
//
// `query` is `vscode.Uri.query`, which VS Code percent-decodes once. The `p`
// value is base64url (URL-safe alphabet, no padding), so it survives that pass
// unchanged. We parse via URLSearchParams then base64url-decode.
export function decodeInjectQuery(query: string): InjectPayload | null {
  if (!query) return null;

  const raw = query.startsWith('?') ? query.slice(1) : query;
  const p = new URLSearchParams(raw).get('p');
  if (!p) return null;

  let json: string;
  try {
    json = Buffer.from(p, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const terminalId = obj.terminalId;
  const text = obj.text;
  if (typeof terminalId !== 'string' || !terminalId) return null;
  if (typeof text !== 'string') return null;

  // enter/combined default to true/false when absent or non-boolean, matching
  // the Ink-safe two-write default the watchdog bridge uses.
  const enter = typeof obj.enter === 'boolean' ? obj.enter : true;
  const combined = typeof obj.combined === 'boolean' ? obj.combined : false;

  return { terminalId, text, enter, combined };
}

// Locate the live terminal for an inject payload. The agents-cli passes the
// session UUID as terminalId, but callers may also pass the internal terminal
// id, so match on either — same lookup shape the watchdog bridge uses.
export function selectInjectTarget<T extends InjectTerminal>(
  terminals: T[],
  terminalId: string
): T | undefined {
  return terminals.find((t) => t.id === terminalId || t.sessionId === terminalId);
}
