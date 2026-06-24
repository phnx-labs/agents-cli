/**
 * Transport seam for encrypted secrets-bundle sync.
 *
 * A `SyncBackend` moves opaque ciphertext envelopes to and from some remote.
 * It NEVER sees plaintext: encryption (`encryptBlob`) happens in `sync.ts`
 * before `putEnvelope`, and decryption (`decryptBlob`) happens after
 * `getEnvelope`. This mirrors the `KeychainBackend` storage seam
 * (`src/lib/secrets/index.ts`) but abstracts *transport* rather than at-rest
 * storage — so the high-level push/pull logic in `sync.ts` is decoupled from
 * any specific backend (Rush's api.prix.dev, a future Supabase driver, an
 * in-memory test double, …).
 */

/** Encrypted bundle envelope (AES-256-GCM, key via PBKDF2-SHA256). All byte
 *  fields are base64. The server only ever stores/returns this — never plaintext. */
export interface EncryptedEnvelope {
  v: 1;
  kdf: 'pbkdf2-sha256';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
  tag: string;
}

/** A stored bundle object: the ciphertext envelope plus a last-updated stamp. */
export interface SyncEnvelope {
  envelope: EncryptedEnvelope;
  updated_at: string;
}

/** Lightweight listing entry returned by `listEnvelopes`. */
export interface RemoteBundleSummary {
  name: string;
  updated_at: string;
}

/**
 * Pluggable transport for encrypted bundles. Implementations handle only the
 * wire/storage; the crypto and bundle snapshot/restore stay backend-agnostic
 * in `sync.ts`.
 */
export interface SyncBackend {
  /** Store (create or overwrite) the envelope for `name`. */
  putEnvelope(name: string, payload: SyncEnvelope): Promise<void>;
  /** Fetch the envelope for `name`, or `null` if the remote has none. */
  getEnvelope(name: string): Promise<SyncEnvelope | null>;
  /** Delete `name` on the remote. Returns false if it didn't exist. */
  deleteEnvelope(name: string): Promise<boolean>;
  /** List every bundle the authenticated user has on the remote. */
  listEnvelopes(): Promise<RemoteBundleSummary[]>;
}
