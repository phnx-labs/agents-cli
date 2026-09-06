# The standalone secrets client (`secrets-client.ts`)

`cli/src/lib/secrets-client.ts` is the **one** process client through which
agents-cli talks to the standalone `secrets` CLI (PHNX-3989). It is the
agents-owned half of the secrets extraction: the engine — bundle storage,
providers, the broker, transports — lives entirely in
[`phnx-labs/secrets-cli`](https://github.com/phnx-labs/secrets-cli), and
agents-cli reaches it only through this seam. agents-cli **never rebundles the
extracted engine** (delta-spec DIST-1); a missing executable fails loud with
install guidance rather than falling back to anything in-repo.

> Status: the client exists; **no consumer is converted to it yet**, and the
> in-repo `cli/src/lib/secrets/` engine is untouched. Converting the consumers in
> `inventory.json` and removing the embedded engine is the next wave (tasks.md
> item 6 onward).

## The seam

Each operation spawns `secrets __serve` and exchanges exactly one JSON message
over inherited pipes — the standalone's private consumer protocol
(`secrets-cli/src/protocol-server.ts`), separate from the child's stdout:

```
parent                              child: `secrets __serve`
  │  request JSON ──────────────────▶  fd 3 (read to EOF)
  │                                     …resolve op…
  │  ◀────────────────── response JSON  fd 4 (write, then exit)
```

- **Wire contract** (mirrored from `secrets-cli/src/protocol.ts`):
  `{ v: 1, id, op, args, context? }` in, `{ v: 1, id, ok, result | error }` out.
  `Map` arguments and results are carried through `encodeWire`/`decodeWire`
  (`{ $map: [[k, v], …] }`). This is the one thing the client re-declares rather
  than imports — a shared schema both sides must agree on byte-for-byte.
- **Handshake**, once per process (cached): the first request sends
  `op: "handshake"` and asserts the server speaks `PROTOCOL_VERSION` (1), else
  throws `PROTOCOL_UNSUPPORTED`.
- **Errors** are `SecretsClientError` carrying the server's `{ code, message }`
  (e.g. `ACCESS_DENIED`, `NOT_FOUND`), or a client-side transport code
  (`SECRETS_BIN_MISSING`, `TIMEOUT`, `PROTOCOL_UNSUPPORTED`, `SPAWN_FAILED`).

### Async and sync

Both primitives spawn one `secrets __serve` per call:

| Primitive | Transport |
|---|---|
| `secretsRequest(op, args?, context?)` | `spawn`; write+end `child.stdio[3]`, read `child.stdio[4]` to EOF. |
| `secretsRequestSync(op, args?, context?)` | `spawnSync`, timeout-bounded. The request rides a **named FIFO** handed to the child as fd 3 (Node has no synchronous `pipe(2)`, and `spawnSync` only feeds stdin); the response is captured through `spawnSync`'s own fd-4 pipe. POSIX only — Windows has no `mkfifo` and fails loud, pointing at the async path. |

`secretsRequestSync` exists for the consumers that resolve secrets on a
synchronous path (building a child env before spawn). Its request must fit the OS
pipe buffer; a larger synchronous request fails loud rather than hanging.

## Environment contract

| Variable | Who sets it | Meaning |
|---|---|---|
| `SECRETS_BIN` | operator/tests (optional) | Path to the `secrets` executable. Absent ⇒ resolved from PATH. A `.js`/`.mjs`/`.cjs` value is run through this process's Node; an installed shim/binary is spawned directly. |
| `SECRETS_HOME` | **this client** | The standalone's state root. Defaults to the user agents dir (`~/.agents`, `getUserAgentsDir()`) so the user's existing stores are adopted **in place** — no copy, no re-encryption (MIG-1). An explicit value in the environment wins (test isolation, power users), matching the standalone's own precedence. |

## Policy: scope and allowed bundles (CTX-1)

The client forwards, it does not compute, the access policy. A caller passes a
`context`:

- `scope` — the harness name, folded into resolution by the standalone.
- `allowedBundles` — a resource-profile-filtered allowlist. Absent ⇒ full trust
  (the local agents client today). Present ⇒ the standalone fails **closed** to
  bundle-named operations and denies anything outside the set (`ACCESS_DENIED`).

Computing `allowedBundles` (resource-profile filtering) and choosing the scope
stay in agents-cli — this client only carries what the caller supplies.

## Typed wrappers

Thin, typed forwards onto the two primitives, one per operation the engine
consumers in `inventory.json` actually use — nothing more:

- **bundles**: `readAndResolveBundleEnv` (+`Sync`), `listBundles`, `readBundle`,
  `bundleExists` (+`Sync`), `writeBundle`, `writeBundleWithItems`, `deleteBundle`
- **agent**: `agentPing` (+`Sync`), `agentStatus`, `agentLock`, `ensureAgentRunning`
- **keychain items**: `getKeychainToken` (+`Sync`), `setKeychainToken`,
  `hasKeychainToken` (+`Sync`), `deleteKeychainToken`, `listKeychainItems`
- **store** (explicit-backend raw item CRUD): `storeGet` (+`Sync`),
  `storeHas` (+`Sync`), `storeSet`, `storeDelete`
- **remote / push**: `remoteResolveEnv`, `pushBundleToHost`, `pushBundleToHostAsync`

The wrapper types are imported `type`-only from the in-repo engine so they are
exactly the shapes today's consumers pass and receive — making the conversion
wave a drop-in. `import type` is fully erased at compile time, so it adds no
runtime edge and nothing to the npm tarball. When the engine is deleted, repoint
those type imports at the published `@phnx-labs/secrets-cli` SDK types.

## Testing

`secrets-client.test.ts` drives the **real** standalone `secrets __serve` (no
mocks). The integration block is gated on `AGENTS_TEST_SECRETS_BIN` pointing at a
built standalone entrypoint, and skips cleanly when unset (the same env-gated
real-dependency pattern as the Windows `--device` e2e suites), so CI — which has
no standalone checkout — stays green. To run it against a checkout:

```bash
# in a secrets-cli checkout on feat/standalone-port
bash scripts/build.sh
# in cli/
AGENTS_TEST_SECRETS_BIN=/path/to/secrets-cli/dist/index.js \
  bun run test src/lib/secrets-client.test.ts
```

Every op runs against a throwaway `HOME`/`SECRETS_HOME` so the user's real store
is never touched.
