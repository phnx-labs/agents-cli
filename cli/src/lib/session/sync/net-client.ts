/**
 * SessionsHttpClient — the managed transport for `agents sessions export
 * --to-r2` / `import --from-r2` when the caller is signed in to Phoenix.
 *
 * Same put / get / list / delete surface as `R2Client` (`./r2.ts`), so the
 * export/import command drives EITHER a managed HTTP client or a BYO S3 client
 * through the one shared {@link SessionsBackupClient} interface. The difference
 * is only the wire: this talks to the managed sessions Worker over `fetch` with
 * a `Authorization: Bearer <phoenix-token>` header (the same request shape as
 * `traces/sync.ts`), instead of SigV4 against R2 directly.
 *
 * The userId namespace prefix is prepended INSIDE this client
 * (`${baseUrl}/${userId}/${key}`), so the caller passes the SAME object key it
 * passes to `R2Client` (`sessions/<machine>/<agent>/<sessionId>.jsonl`). That
 * keeps the BYO object layout (SES-27a) byte-identical while the managed Worker
 * gets its required `segments[0] === userId` prefix.
 */

/**
 * The verbs the session backup/restore path needs, satisfied by BOTH the
 * managed {@link SessionsHttpClient} and the BYO `R2Client`. `list` takes an
 * optional prefix: BYO passes the `sessions/` prefix; managed ignores it and
 * enumerates the whole owner namespace server-side.
 */
export interface SessionsBackupClient {
  readonly kind: 'managed' | 'byo';
  put(key: string, body: string | Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(prefix?: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** Managed-only extension used to establish an immutable escrow key. */
export interface ManagedSessionsBackupClient extends SessionsBackupClient {
  readonly kind: 'managed';
  putIfAbsent(key: string, body: string | Uint8Array, contentType?: string): Promise<boolean>;
}

export class SessionsHttpClient implements ManagedSessionsBackupClient {
  readonly kind = 'managed' as const;
  private base: string;
  private userId: string;
  private token: string;

  constructor(opts: { baseUrl: string; userId: string; token: string }) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.userId = safeOwnerSegment(opts.userId);
    this.token = opts.token;
  }

  /** `${baseUrl}/<userId>/<key>` with every path segment percent-encoded. */
  private objUrl(key: string): string {
    const rel = safeObjectKey(key).map(encodeURIComponent).join('/');
    return `${this.base}/${encodeURIComponent(this.userId)}/${rel}`;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  /** Upload an object under this owner's namespace. Overwrites unconditionally. */
  async put(key: string, body: string | Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    const res = await fetch(this.objUrl(key), {
      method: 'PUT',
      headers: this.authHeaders({ 'content-type': contentType }),
      body,
    });
    if (!res.ok) throw new Error(`sessions PUT ${key} failed: ${res.status} ${await safeText(res)}`);
  }

  /** Create an object exactly once. A concurrent winner returns false. */
  async putIfAbsent(
    key: string,
    body: string | Uint8Array,
    contentType = 'application/octet-stream',
  ): Promise<boolean> {
    const res = await fetch(this.objUrl(key), {
      method: 'PUT',
      headers: this.authHeaders({ 'content-type': contentType, 'if-none-match': '*' }),
      body,
    });
    if (res.status === 409) return false;
    if (!res.ok) {
      throw new Error(`sessions PUT-IF-ABSENT ${key} failed: ${res.status} ${await safeText(res)}`);
    }
    return true;
  }

  /** Fetch an object as text, or null if it does not exist (404). */
  async get(key: string): Promise<string | null> {
    const res = await fetch(this.objUrl(key), { method: 'GET', headers: this.authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`sessions GET ${key} failed: ${res.status} ${await safeText(res)}`);
    return await res.text();
  }

  /**
   * List this owner's object keys, each relative to the `<userId>/` prefix (so
   * they feed straight back into `get`/`delete`). The `prefix` arg is accepted
   * for interface parity with `R2Client` but ignored — the managed Worker
   * enumerates the whole owner namespace and excludes the reserved `__` keys
   * server-side.
   */
  async list(_prefix?: string): Promise<string[]> {
    const url = `${this.base}/${encodeURIComponent(this.userId)}/?list`;
    const res = await fetch(url, { method: 'GET', headers: this.authHeaders() });
    if (!res.ok) throw new Error(`sessions LIST failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!body || !Array.isArray(body.keys)) return [];
    return body.keys.filter((k): k is string => typeof k === 'string');
  }

  /** Delete an object (the Worker refunds its bytes to the quota ledger). */
  async delete(key: string): Promise<void> {
    const res = await fetch(this.objUrl(key), { method: 'DELETE', headers: this.authHeaders() });
    if (!res.ok && res.status !== 404) {
      throw new Error(`sessions DELETE ${key} failed: ${res.status} ${await safeText(res)}`);
    }
  }
}

function safeOwnerSegment(owner: string): string {
  const value = owner.trim();
  if (!value || value === '.' || value === '..' || value.includes('/')) {
    throw new Error(`Invalid managed sessions user id: ${JSON.stringify(owner)}`);
  }
  return value;
}

/** Prevent URL dot-segment normalization from escaping the verified owner path. */
function safeObjectKey(key: string): string[] {
  const segments = key.split('/');
  if (
    segments.length === 0 ||
    segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid managed sessions object key: ${JSON.stringify(key)}`);
  }
  return segments;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
