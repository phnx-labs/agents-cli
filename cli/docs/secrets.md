# Secrets and credential custody

> **Extraction in progress (PHNX-3989).** The engine this page describes — bundle
> storage, the broker, the keychain/file/vault backends — is being extracted to the
> standalone [`@phnx-labs/secrets-cli`](https://github.com/phnx-labs/secrets-cli)
> package. agents-cli reaches it only through the bounded process client documented in
> [`secrets-client.md`](secrets-client.md); it never rebundles the engine (DIST-1). As
> each consumer converts, `agents secrets <anything>` becomes a **thin exec passthrough**
> to the installed `secrets` binary (`commands/secrets-passthrough.ts`) — it forwards
> argv verbatim with `SECRETS_HOME` defaulted to `~/.agents` (so the standalone adopts
> the user's existing store in place, MIG-1) and fails loud with install guidance
> (`npm i -g @phnx-labs/secrets-cli`) when the executable isn't found. There is no
> fallback to the in-repo engine below. `agents setup secrets` is the matching
> onboarding entry point: install guidance, then a hand-off to the standalone's own
> `secrets migrate`. The design principles below (storage vs. materialization,
> the reserved `auth` bundle, the Linux file-store fallback) still hold — they describe
> the store's actual behavior — but the implementation they describe is moving out of
> this repo. Read `secrets-client.md` first for the current architecture.

Secret values are never DotAgents resources. Portable repositories contain names and
policy only; values live in a platform-backed store or encrypted headless store.

```mermaid
flowchart LR
  META[Portable bundle names and policy] --> R[Run resolution]
  STORE[(Platform or encrypted store)] --> B[Secrets broker]
  R --> B
  B --> ENV[Child-only environment]
  ENV --> H[Harness process]
  B --> AUDIT[Value-free audit metadata]
```

## Two boundaries

Storage protection answers where plaintext rests. Materialization protection answers
whether a value enters agent-visible stdout, environment, files, or transcripts. They are
separate guarantees.

Injection passes named values directly into a child environment without printing them.
Materialization deliberately reveals a value and therefore requires the policy and human
gate defined by the current command contract. All materializing paths must agree; a
command-specific exception cannot contradict the system threat model.

The daemon hosts the lightweight broker so repeated launches do not trigger repeated
platform prompts. Expensive or failure-prone work remains outside the daemon's critical
loop. Remote use transports values on demand to an authenticated target and never turns
them into synced plaintext.

The reserved `auth` bundle is file-backed by construction: it holds long-lived Claude
setup-tokens that usage/probe and unattended workers read without Touch ID. Creating it
on the keychain or vault backend fails loud. The daemon's `auth-sync` service publishes
only a `ready`/`missing`/`invalid` verdict to the owning device's tracked
`~/.agents/devices/<device>/daemon-state.json`; a serialized, 45-second-bounded
Git exchange automatically delivers those verdicts through the user repo. One
deterministically elected ready device asynchronously pushes the real bundle only to pinned peers whose synced verdict
says `missing`, always with the file backend and a kill-bounded SSH deadline so each
destination auto-provisions its own machine-local key. Tokens never enter the Git store.

**The usage-read credential is role-gated (USAGE-READ-1/2).** By default a usage read
resolves only this file-based setup-token, never the interactive login (RUSH-1822) —
the guarantee every background caller (daemon usage warm, auth-health probe, watchdog)
keeps, since the fleet-logout revocation came from an unattended loop firing the
interactive token at Anthropic. The setup-token itself lacks the `user:profile` scope a
usage read requires (RUSH-2392), so on a `worker`/unmarked device — or any `--json` or
piped reader — an account signed in interactively and nothing else reports `usage
unavailable (no usage credential)`. `agents view` names that state precisely instead of
folding it into the generic bucket, which used to send operators back to `claude
setup-token` for a remedy that cannot work (#2987); a cache that has not been read yet
reports the distinct `usage pending`.

The one exception is a **foreground human `agents view` on a `personal` device**
(`selfConfiguredDeviceRole() === 'personal'` **and** `process.stdout.isTTY`): the read
falls through to the interactive OAuth login — the only credential carrying
`user:profile` — so `agents view --refresh` repopulates a live session (5h) + week (7d)
bar for every signed-in account. This mirrors the exec-credential role gate (EXEC-2a):
the personal box authenticates from its interactive login; unattended loops and machine
readers never touch it. A usage read never *refreshes* an access token — an expired
interactive login reports `expired-credential`, not a silent refresh.

Actors, audit events, and usage counters contain metadata only. Redaction is defense in
depth, not permission to publish raw transcripts.

## Linux: headless servers and the encrypted-file fallback

Off macOS there is no platform keychain, so the encrypted-file store is the backend. Its
data key is unwrapped from a machine-local key file at `~/.agents/.secrets-key/passphrase`
— mode 0600, generated on first use, never synced and never a DotAgents resource. That
file *is* the store: a machine that has it can read every bundle on it.

Resolution is entirely non-interactive: the daemon-hosted broker reads the key file
directly, and there is **no TTY step anywhere in this list**. A command that appears to
wait for a passphrase is waiting for the *transport* passphrase of `secrets push` /
`secrets pull` / `--to-file`, which is `AGENTS_SYNC_PASSPHRASE` — a different secret with
a different lifetime. Headless sync is configured with that transport variable.

**Bundle metadata is cached in plaintext; secret values never are (PHNX-3585).** Every
`.enc` file carries its own scrypt salt, so decrypting one runs a fresh ~12ms KDF.
Enumerating bundles (`secrets list`, and the `agents run` account rotation) decrypted
every bundle's metadata, which was ~0.6s of pure KDF on a box with dozens of bundles,
paid before the harness even started. Bundle *metadata* is non-secret by contract (it
holds `keychain:`/`env:`/literal refs, never the secret bytes, and is already stored
no-ACL so listing needs no Touch ID), so the file store caches the decrypted metadata
JSON at `~/.agents/.cache/secrets.meta-cache.json` — a machine-local, 0600, never-synced
sibling of the store — keyed by each `.enc` file's `(mtime,size)` plus a passphrase
fingerprint. Any write (new mtime/size) or passphrase change (new fingerprint; rotation
re-writes every file) misses and re-derives, so it is self-healing with no staleness, and
secret *value* items are never read through it. Profile the boot window yourself with
`AGENTS_PROFILE_BOOT=1 agents run <agent> …` or the committed `cli/scripts/bench-boot.sh`.

<!-- docs-hygiene:allow-master-key-discussion -->
**Never place the master key in a shell startup file.** `AGENTS_SECRETS_PASSPHRASE`
overrides the key file, so exporting it from `~/.zshenv`, `~/.bashrc`, or any other rc
file leaves the plaintext key readable by every process the account starts — including
agents — and `agents doctor` reports it as an `env-secret-export` warning. This is not
hypothetical: it is what RUSH-1968 was, on seven machines at once, because an earlier
revision of this page recommended it.
<!-- /docs-hygiene:allow-master-key-discussion -->

<!-- docs-hygiene:allow-master-key-discussion -->
`agents secrets export --device --remote-backend file` never forwards
`AGENTS_SECRETS_PASSPHRASE`. The remote auto-provisions its own machine-local key
so headless reads work. Forwarding that env var used to key destination ciphertext
to a secret the remote daemon did not hold, while import still printed success.
<!-- /docs-hygiene:allow-master-key-discussion -->
