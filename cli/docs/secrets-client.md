# The standalone secrets client (`secrets-client.ts`)

`cli/src/lib/secrets-client.ts` is the **one** process client through which
agents-cli talks to the standalone `secrets` CLI (PHNX-3989). It is the
agents-owned half of the secrets extraction: the engine — bundle storage,
providers, the broker, transports — lives entirely in
[`phnx-labs/secrets-cli`](https://github.com/phnx-labs/secrets-cli), and
agents-cli reaches it only through this seam. agents-cli **never rebundles the
extracted engine** (delta-spec DIST-1); a missing executable fails loud with
install guidance rather than falling back to anything in-repo.

> Status: the consumer-conversion wave (tasks.md item 6) is **in progress** across
> tracks. The run/exec hot path (`commands/exec.ts`, `lib/exec.ts`, `lib/crabbox/*`,
> `lib/cloud/{cursor,antigravity}.ts`) resolves through this client, and Track C
> (browser, share, ssh, apply, sync, webhook, fleet-capture, doctor, setup-secrets,
> and their library dependencies) is converted too — including making
> `agents secrets` itself a thin exec passthrough
> (`commands/secrets-passthrough.ts`), with the old `commands/secrets.ts` registrar
> left in the tree, unregistered, until every other track's consumers convert.
> Other consumers in `inventory.json` are still being converted, and the in-repo
> `cli/src/lib/secrets/` engine is **not yet removed** — it stays until every
> consumer is off it (tasks.md item 7). Agents-owned policy that happens to live in
> the engine tree (spawn-env hardening, `bundle@host` fleet-alias resolution) is
> passed into the client, not converted, and relocates out of the engine tree as
> part of that retirement.

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
| `SECRETS_PASSPHRASE` | **this client** (bridged) | The file-store encryption key the standalone reads. The extraction renamed every `AGENTS_SECRETS_*` knob to `SECRETS_*`, so `buildServeEnv` forwards a caller env still carrying the old `AGENTS_SECRETS_PASSPHRASE` (the name agents-cli's own engine reads) onto `SECRETS_PASSPHRASE` for the child — otherwise the standalone can't decrypt the very file store agents-cli wrote and would silently provision a fresh machine-local key (MIG-1: never silently choose another key after a decryption miss). An explicit `SECRETS_PASSPHRASE` already in the env wins; the bridge only fills the rename gap. |

The child inherits the rest of the parent env, so `SECRETS_SCOPE`/`SECRETS_CONTEXT`
already present pass through — but the client does not need to set them: the
per-request harness scope rides the protocol `context.scope` (below), and
`secrets __serve` marks its own process `SECRETS_CONTEXT=agent`.

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

Thin, typed forwards onto the two primitives — the resolve/read/write/raw-CRUD
operations agents-cli's consumers hit today:

- **bundles**: `readAndResolveBundleEnv` (+`Sync`), `listBundles` (+`Sync`),
  `readBundle` (+`Sync`), `bundleExists` (+`Sync`), `bundleBackend` (+`Sync`),
  `writeBundle`, `writeBundleWithItems` (+`Sync`), `deleteBundle`, `describeBundle`
- **agent**: `agentPing` (+`Sync`), `agentStatus`, `agentLock`, `ensureAgentRunning`
- **keychain items**: `getKeychainToken` (+`Sync`), `setKeychainToken`,
  `hasKeychainToken` (+`Sync`), `deleteKeychainToken`, `listKeychainItems`
- **store** (explicit-backend raw item CRUD): `storeGet` (+`Sync`),
  `storeHas` (+`Sync`), `storeSet`, `storeDelete`
- **remote / push**: `remoteResolveEnv`, `pushBundleToHost`, `pushBundleToHostAsync`
- **sync** (the `agents sync --secrets` umbrella stage): `listRemoteBundles`, `pullBundle`
- **rc-hygiene** (the `agents doctor` shell-rc-export advisory): `scanUserRcFiles`
  (+`Sync`), `masterPassphraseInEnv` (+`Sync`)

Each `Sync` sibling exists because its consumer resolves the value on a
synchronous path (building a child env, or a `doctor`/JSON-building function
that isn't itself async) — added alongside the async wrapper only when a real
call site needed it, not speculatively.

Two pure, wire-level naming helpers are **re-declared rather than wrapped**,
the same treatment as `encodeWire`/`decodeWire`: `secretsKeychainItem(bundle,
key)` and `keychainRef(key)` compute the standalone's keychain/file item
naming and var-ref format with no RPC round trip (MIG-1 pins this format as a
stable wire contract, not an internal detail that can drift). A caller that
needs to write a raw item under the bundle's own naming convention (e.g.
`share/config.ts`'s `storeWriteToken`) uses these plus `writeBundleWithItems`
rather than composing the write by hand.

This is deliberately **not** the standalone's full op table. The remaining
bundle-metadata mutation ops it also exposes — `renameBundle`,
`rotateBundleSecret`, `bundlePolicy`, `readBundleIfDecryptable`,
`keychainItemsForBundle`, `migrateLegacyBundles` — get their wrapper as the
consumer-conversion wave (tasks.md item 6) lands the caller that needs it, so a
wrapper always ships with a real call site and a test rather than as
speculative unused surface. Converting a consumer that needs one of these is
"add the one-line forward + convert the call site", not a blocked drop-in.

`invocation(bin)` (exported alongside `resolveSecretsBin`) is the one non-op
export: it resolves how to spawn the binary (through this process's Node for a
`.js` entrypoint, or directly for an installed shim), for a caller that needs
to run a standalone verb this client doesn't wrap as an op — the `agents
secrets` passthrough (`commands/secrets-passthrough.ts`, execs any subcommand
verbatim) and `agents setup secrets` (hands off to the standalone's own
interactive `secrets migrate`) both use it.

The wrapper types are imported `type`-only from the in-repo engine so they are
exactly the shapes today's consumers pass and receive. `import type` is fully
erased at compile time, so it adds no runtime edge and nothing to the npm
tarball. When the engine is deleted, repoint those type imports at the published
`@phnx-labs/secrets-cli` SDK types.

## Testing

`secrets-client.test.ts` drives the **real** standalone `secrets __serve` (no
mocks). The integration block is gated on `AGENTS_TEST_SECRETS_BIN` pointing at a
built standalone entrypoint, and skips cleanly when unset (the same env-gated
real-dependency pattern as the Windows `--device` e2e suites), so CI — which has
no standalone checkout — stays green. To run it against a checkout:

```bash
# in a secrets-cli checkout (main)
bun install --frozen-lockfile && bash scripts/build.sh
# in cli/
AGENTS_TEST_SECRETS_BIN=/path/to/secrets-cli/dist/index.js \
  bun run test src/lib/secrets-client.test.ts
```

The integration block sets the legacy `AGENTS_SECRETS_PASSPHRASE` (not
`SECRETS_PASSPHRASE`) on purpose, so the round-trip exercises the passphrase
bridge above on the real store; `buildServeEnv` itself is pinned by pure unit
tests that always run.

Every op runs against a throwaway `HOME`/`SECRETS_HOME` so the user's real store
is never touched.
