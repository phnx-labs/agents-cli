# Secrets

Named bundles of environment variables backed by macOS Keychain — device-local, biometry-gated, injected into agent runs at spawn time.

## Overview

Secrets solves the problem of getting API keys into agent processes without storing them in plaintext on disk or in shell history. Every secret value lives in macOS Keychain as a separate item gated by Touch ID or device passcode. Bundle metadata (name, description, variable names) is also stored in Keychain as a JSON blob — nothing about secrets ever exists as a file.

A bundle is a named container (`prod`, `staging`, `npm-tokens`) that maps env var names to values or typed references. When an agent is spawned with `--secrets <bundle>`, the CLI resolves the bundle, reads all keychain-backed values in a single batch Touch ID prompt, and injects the resulting env map into the child process.

Cross-machine sync goes through an explicit encrypted push/pull flow (`agents secrets push/pull`) backed by api.prix.dev. Values are sealed with AES-256-GCM before upload — plaintext never leaves the machine.

> **Platform:** macOS Keychain or Linux libsecret. Windows is not supported.

## Architecture

```
macOS Keychain
  agents-cli.bundles.prod         <- bundle metadata (JSON blob)
  agents-cli.secrets.prod.STRIPE_API_KEY
  agents-cli.secrets.prod.RESEND_KEY

  agents-cli.bundles.staging
  agents-cli.secrets.staging.STRIPE_API_KEY

                  ┌──────────────────────────────┐
  agents run      │  readAndResolveBundleEnv      │
  --secrets prod  │  1. list  agents-cli.secrets.prod.* (silent, no biometry)
  ───────────────▶│  2. get-batch [meta + values] │──▶ ONE Touch ID prompt
                  │  3. inject env into child     │
                  └──────────────────────────────┘

Variable kinds (stored in bundle metadata, resolved at inject time):

  keychain:<key>   value lives in agents-cli.secrets.<bundle>.<key>
  literal          value stored inline in metadata JSON (non-sensitive)
  env:<VAR>        read from parent process.env at run time
  file:<path>      read from a file at run time
  exec:<cmd>       run a command and capture stdout (requires allow_exec: true)
```

Source: `src/lib/secrets/index.ts:43` (`REF_PATTERN`), `src/lib/secrets/bundles.ts:57-71` (`SecretsBundle`).

The batch-read design means `agents secrets list` pops Touch ID once for all bundles, not once per bundle. Source: `src/lib/secrets/bundles.ts:269-271`.

## File-backed bundles (headless / remote)

The keychain backend is biometry-gated, so it can't be read on a headless Mac
over SSH — there's no GUI session to satisfy Touch ID / the device passcode.
A **file-backed** bundle stores the same items in an AES-256-GCM encrypted-file
store (`~/.agents/.cache/secrets/<item>.enc`, scrypt-derived key) keyed by
`AGENTS_SECRETS_PASSPHRASE` instead — no biometry, fully headless. Source:
`src/lib/secrets/filestore.ts`, routed per-bundle in `src/lib/secrets/bundles.ts`
(`bundleBackend`, `bundleItemStore`).

```
~/.agents/.cache/secrets/
  agents-cli.bundles.rush.releases.enc          <- metadata (encrypted)
  agents-cli.secrets.rush.releases.TOKEN.enc    <- value (encrypted)
```

- **Opt-in.** Create with `--backend file` (or `import --backend file`). Keychain
  stays the default; existing bundles are untouched.
- **macOS requires an explicit passphrase.** On a Mac the file store never
  auto-provisions a machine-local key — reads/writes need `AGENTS_SECRETS_PASSPHRASE`
  in the environment (or an interactive prompt). This keeps the box holding only
  ciphertext: the passphrase is supplied per run, not stored next to the data.
  (Linux keeps the existing locked-keyring auto-provision fallback.)
- **The passphrase is the one key.** Hold it in a biometry-gated keychain bundle
  on a trusted machine and forward it per run; never commit it.

Recommended custody for a remote release (laptop keeps the key, the remote Mac
holds only ciphertext): see [Recipe 8](#8-headless-release-on-a-remote-mac).

## Remote secrets (read & use from other hosts)

Browse and *use* the bundles that live on another machine, over the same hardened
SSH path that `secrets export --host` (the write direction) already uses. Hosts
resolve through the `agents hosts` registry, an ssh-config alias, or `user@host`.

```bash
# Browse one host, or several at once (grouped by host)
agents secrets list --host yosemite-s1
agents secrets list --hosts yosemite-s0,yosemite-s1
agents secrets view --host yosemite-s1 r2.backups --reveal --plaintext

# Use a remote bundle ephemerally — values are injected, never stored locally
agents secrets exec --host yosemite-s1 r2.backups -- ./deploy.sh
agents run claude "ship it" --secrets r2.backups@yosemite-s1   # bundle@host suffix
```

- **`--host <target>`** (single) and **`--hosts <a,b,c>`** (comma list) compose on
  `list` / `view`; **`bundle@host`** is the reference form for `run --secrets` and
  the target for `exec --host`.
- **Ephemeral.** Remote values cross over ssh stdout (encrypted in transit), are
  parsed in memory, and injected into the run/command env — never written to this
  machine's keychain or disk.
- **The remote unlocks with its own credentials.** A file-backed remote bundle
  reads headlessly via the remote's own `AGENTS_SECRETS_PASSPHRASE`; a keychain
  bundle on a macOS remote will block on Touch ID under non-interactive SSH — use
  a remote `file` bundle, an already-unlocked remote secrets-agent, or run
  `view --reveal` from an interactive terminal (it forces an SSH TTY so the prompt
  can surface). This machine's passphrase is never forwarded.

Source: `src/lib/secrets/remote.ts` (transport + resolve), wired into `list` /
`view` / `exec` in `src/commands/secrets.ts` and the `--secrets` loop in
`src/commands/exec.ts`. The lossless wire format is `secrets export --format json`.

## Command Reference

### Bundle commands

| Command | Description | Example |
|---------|-------------|---------|
| `secrets list` / `ls` | List bundles with key count, expiry warnings, timestamps | `agents secrets list` |
| `secrets view [name]` | Show keys in a bundle (values masked by default) | `agents secrets view prod` |
| `secrets view [name] --reveal` | Print keychain values in the clear (TTY only) | `agents secrets view prod --reveal` |
| `secrets view [name] --reveal --plaintext` | Allow `--reveal` in non-interactive shells | `agents secrets view prod --reveal --plaintext` |
| `secrets create [name]` | Create an empty bundle | `agents secrets create prod` |
| `secrets create [name] --description <text>` | Create with a description | `agents secrets create prod --description "Live API keys"` |
| `secrets create [name] --allow-exec` | Enable exec: refs in this bundle | `agents secrets create tools --allow-exec` |
| `secrets create [name] --backend <keychain\|file>` | Storage backend; `file` is passphrase-encrypted and headless-readable (see [File-backed bundles](#file-backed-bundles-headless--remote)) | `agents secrets create rush.releases --backend file` |
| `secrets create [name] --force` | Overwrite an existing bundle | `agents secrets create prod --force` |
| `secrets rename <old> <new>` / `mv` | Rename bundle and move all keychain items | `agents secrets rename staging prod` |
| `secrets rename <old> <new> --force` | Overwrite destination if it exists | `agents secrets rename old new --force` |
| `secrets describe <name> [text...]` | Update the bundle description | `agents secrets describe prod "Live keys, EU region"` |
| `secrets describe <name> --clear` | Remove the description | `agents secrets describe prod --clear` |
| `secrets delete [name]` | Delete bundle and purge keychain items | `agents secrets delete prod` |
| `secrets delete [name] --keep-secrets` | Delete metadata but leave keychain items | `agents secrets delete prod --keep-secrets` |
| `secrets delete [name] -y` | Skip confirmation prompt | `agents secrets delete prod -y` |

### Secret (variable) commands

| Command | Description | Example |
|---------|-------------|---------|
| `secrets add [bundle] [key]` | Add a key (default: keychain-backed, prompts for value) | `agents secrets add prod STRIPE_API_KEY` |
| `secrets add ... --value <v>` | Store as a plaintext literal | `agents secrets add prod LOG_LEVEL --value info` |
| `secrets add ... --value-stdin` | Read value from stdin | `echo $KEY \| agents secrets add prod MY_KEY --value-stdin` |
| `secrets add ... --env <VAR>` | Store as an env: ref | `agents secrets add prod TOKEN --env CI_TOKEN` |
| `secrets add ... --file <path>` | Store as a file: ref | `agents secrets add prod CERT --file ~/.certs/prod.pem` |
| `secrets add ... --exec <cmd>` | Store as an exec: ref (requires allow_exec) | `agents secrets add tools DB_PASS --exec "op read op://vault/db/password"` |
| `secrets add ... --type <kind>` | Tag with a secret type | `agents secrets add prod KEY --type api-key` |
| `secrets add ... --expires <YYYY-MM-DD>` | Set expiration date (future-dated only) | `agents secrets add prod KEY --expires 2027-01-15` |
| `secrets add ... --note <text>` | Attach a freeform note | `agents secrets add prod KEY --note "owner: payments-team"` |
| `secrets rotate [bundle] [key]` | Replace the value of a keychain-backed key (preserves metadata) | `agents secrets rotate prod STRIPE_API_KEY` |
| `secrets rotate ... --value-stdin` | Rotate with value from stdin | `echo $NEW \| agents secrets rotate prod KEY --value-stdin` |
| `secrets rotate ... --clear-meta` | Rotate and wipe all metadata for that key | `agents secrets rotate prod KEY --clear-meta` |
| `secrets rotate ... --expires <YYYY-MM-DD>` | Rotate and update expiry | `agents secrets rotate prod KEY --expires 2028-06-01` |
| `secrets remove [bundle] [key]` | Remove a key and purge its keychain item | `agents secrets remove prod OLD_KEY` |
| `secrets remove ... --keep-secret` | Remove from bundle but leave keychain item | `agents secrets remove prod KEY --keep-secret` |
| `secrets import [bundle] --from <path>` | Import keys from a .env file (keychain-backed by default) | `agents secrets import prod --from .env.prod` |
| `secrets import [bundle] --from-1password --vault <name>` | Import from a 1Password vault (requires `op` CLI) | `agents secrets import prod --from-1password --vault Personal` |
| `secrets import ... --all-plaintext` | Store imported values as literals, skip keychain | `agents secrets import prod --from .env --all-plaintext` |
| `secrets import ... --force` | Overwrite existing keys | `agents secrets import prod --from .env --force` |
| `secrets export [bundle]` | Print `KEY=VALUE` lines for shell eval | `eval "$(agents secrets export prod --plaintext)"` |
| `secrets export [bundle] --to-1password --vault <name>` | Push bundle to a 1Password vault | `agents secrets export prod --to-1password --vault Team` |
| `secrets export ... --force` | Overwrite existing 1Password items | `agents secrets export prod --to-1password --vault Team --force` |

### Agent commands (macOS)

| Command | Description | Example |
|---------|-------------|---------|
| `secrets start` | Install + run the secrets-agent as a persistent background service (survives heavy load; reads connect instantly) | `agents secrets start` |
| `secrets stop` | Stop + remove the persistent service and wipe what it held | `agents secrets stop` |
| `secrets unlock [names...]` | Read a bundle once (one Touch ID) and hold it in the secrets-agent so later runs read it silently | `agents secrets unlock prod` |
| `secrets unlock --all` | Unlock every configured bundle | `agents secrets unlock --all` |
| `secrets unlock <name> --ttl <dur>` | Hold for a custom lifetime (default 7d) | `agents secrets unlock prod --ttl 30m` |
| `secrets lock [names...]` | Wipe held bundles from the agent (default: all) — next read re-prompts | `agents secrets lock` |
| `secrets status` | Show which bundles the agent holds and when they lock | `agents secrets status` |
| `secrets policy <bundle> [policy]` | Show or set a bundle's prompt policy: `daily` (default), `always`, or `never` (silent, no biometry ACL — needs `--i-understand`) | `agents secrets policy signing always` |
| `secrets create <name> --policy always` | Create a bundle that prompts on every read | `agents secrets create signing --policy always` |
| `secrets create <name> --policy never --i-understand` | Create a silent, unprotected (no biometry ACL) automation-only bundle | `agents secrets create ci-cache --policy never --i-understand` |

See [The secrets-agent](#the-secrets-agent-macos) below for the model and the security trade-off.

### Sync commands

| Command | Description | Example |
|---------|-------------|---------|
| `secrets push [name]` | Encrypt and upload a bundle to api.prix.dev | `agents secrets push prod` |
| `secrets push --all` | Push every local bundle | `agents secrets push --all` |
| `secrets pull [name]` | Decrypt and restore a remote bundle locally | `agents secrets pull prod` |
| `secrets remote-list` | List bundles stored remotely | `agents secrets remote-list` |

### Utilities

| Command | Description | Example |
|---------|-------------|---------|
| `secrets exec <bundle> [command...]` | Run a command with the bundle injected | `agents secrets exec prod -- ./deploy.sh` |
| `secrets generate [length]` | Generate a random password (default 32 chars) | `agents secrets generate 24` |
| `secrets generate --pin` | Digits only | `agents secrets generate 6 --pin` |
| `secrets generate --hex` | Hex characters (0-9, a-f) | `agents secrets generate 32 --hex` |
| `secrets generate --strong` | All character classes | `agents secrets generate 48 --strong` |
| `secrets generate -c` / `--copy` | Copy to clipboard, do not print | `agents secrets generate --copy` |
| `secrets migrate` | Interactively migrate legacy YAML bundles into Keychain | `agents secrets migrate` |
| `secrets migrate-acl` | Upgrade legacy keychain items to the biometry ACL | `agents secrets migrate-acl` |

## Configuration Schema

Bundle metadata is stored in Keychain as JSON. The shape maps to `SecretsBundle` at `src/lib/secrets/bundles.ts:57-71`.

```yaml
# Conceptual representation of bundle metadata (not a file on disk)

name: prod                          # string, required — [a-z0-9][a-z0-9\-_.]{0,48}
description: "Production API keys"  # string, optional
allow_exec: false                   # boolean, optional (default false)
                                    # Must be true to use exec: refs in this bundle

created_at: "2026-01-15T10:00:00Z"  # ISO 8601 UTC — set once on first write
updated_at: "2026-05-20T14:32:00Z"  # ISO 8601 UTC — refreshed on every write
last_used: "2026-06-01T08:00:00Z"   # ISO 8601 UTC — stamped on env resolution (throttled)

vars:
  STRIPE_API_KEY: "keychain:STRIPE_API_KEY"   # keychain-backed (default for `add`)
  LOG_LEVEL: { value: "info" }                # literal (--value flag; avoids ref parsing)
  CI_TOKEN: "env:CI_TOKEN"                    # env: ref — reads from parent process.env
  CERT_PEM: "file:~/.certs/prod.pem"          # file: ref — reads file at run time
  DB_PASS: "exec:op read op://vault/db/pass"  # exec: ref — runs command (requires allow_exec)

meta:                                         # optional per-var metadata
  STRIPE_API_KEY:
    type: api-key                             # SecretType: api-key | token | password | url
                                             #   database-url | ssh-key | certificate | webhook | note
    expires: "2027-01-15"                    # YYYY-MM-DD, always future-dated at write time
    note: "Live key, owner: payments-team"   # freeform string
```

Secret types sourced from `SECRET_TYPES` at `src/lib/secrets/bundles.ts:35-45`. Variable kinds sourced from `REF_PATTERN` at `src/lib/secrets/index.ts:43`.

## Recipes

### 1. Create a bundle and add secrets

```bash
# Create an empty bundle
agents secrets create prod --description "Production keys for the API stack"

# Add a keychain-backed secret (prompts for value)
agents secrets add prod STRIPE_API_KEY --type api-key --expires 2027-01-15

# Add a non-sensitive literal
agents secrets add prod LOG_LEVEL --value info

# View the bundle (values masked)
agents secrets view prod
```

### 2. Inject into `agents run`

```bash
# Run an agent with the bundle's env injected
agents run claude "process this week's invoices" --secrets prod

# Merge order: profile env < --secrets < --env K=V
# Override one value at run time without touching the bundle:
agents run claude "test with staging key" --secrets prod --env STRIPE_API_KEY=$TEST_KEY
```

### 3. Import from a .env file or 1Password

```bash
# Bulk import from a .env file (each value stored in keychain)
agents secrets import prod --from .env.prod

# Import from 1Password vault (requires `op` CLI and signin)
agents secrets import prod --from-1password --vault Personal

# Import without hitting keychain (literals only, less secure)
agents secrets import staging --from .env.staging --all-plaintext
```

### 4. Rotate a secret

Rotation replaces the keychain value and preserves existing metadata unless you override it:

```bash
# Rotate interactively (prompts for new value)
agents secrets rotate prod STRIPE_API_KEY

# Rotate from stdin (CI)
echo "$NEW_KEY" | agents secrets rotate prod STRIPE_API_KEY --value-stdin

# Rotate with an updated expiry and note
agents secrets rotate prod STRIPE_API_KEY \
  --expires 2028-01-15 \
  --note "rotated after employee offboarding"

# Rotate and clear all metadata
agents secrets rotate prod STRIPE_API_KEY --clear-meta
```

The `list` command flags secrets with `--expires` dates in the next 30 days in the EXPIRING column. Source: `src/commands/secrets.ts:331-340`.

### 5. Share a bundle with a teammate

```bash
# Push encrypted to api.prix.dev (prompts for a passphrase)
agents secrets push prod

# Teammate pulls on their machine
agents secrets pull prod
# (prompted for the same passphrase)
```

Plaintext never leaves the machine — the bundle is sealed with AES-256-GCM before upload. Source: `src/commands/secrets-sync.ts:7-8`.

### 6. Run a one-off command with secrets

```bash
# Run a deploy script with the prod bundle injected (no agents run needed)
agents secrets exec prod -- ./scripts/deploy.sh

# Eval into your current shell
eval "$(agents secrets export prod --plaintext)"
```

### 7. Website logins with multiple accounts

Name the bundle after the domain and group keys by account handle — one bundle per site, any number of accounts inside. Per-key `--note` records when to use each account; `view` prints notes in the clear while values stay masked, so an agent can pick the right account without revealing anything:

```bash
agents secrets create x.com --description "X/Twitter accounts. Read key notes to pick the right one."

agents secrets add x.com ZEFFMUKS_USERNAME --value zeffmuks \
  --note "Personal account. Casual engagement, memes."
agents secrets add x.com ZEFFMUKS_PASSWORD --type password \
  --note "Password for @zeffmuks"
agents secrets add x.com SOCIAL_GETRUSH_USERNAME --value social@getrush.ai \
  --note "Official Rush brand account. Marketing, announcements."
agents secrets add x.com SOCIAL_GETRUSH_PASSWORD --type password \
  --note "Password for social@getrush.ai"

# Pick an account by reading notes, then reveal just that account's pair
agents secrets view x.com
agents secrets export x.com --plaintext | grep '^SOCIAL_GETRUSH_'

# Or bind the bundle to a browser profile so it injects at browser start
agents browser profiles create x --browser chrome --secrets x.com
```

Key naming: uppercase the handle, replace non-alphanumerics with `_`, suffix `_USERNAME` / `_PASSWORD` (plus `_TOTP_SECRET` for 2FA accounts).

### 8. Headless release on a remote Mac

Run a release on a headless Mac (e.g. a build host reached over SSH) that needs
signing/release secrets, without any Touch ID on the remote. The laptop holds
the one passphrase (biometry-gated) and hands it over per run; the remote holds
only ciphertext. See [File-backed bundles](#file-backed-bundles-headless--remote).

```bash
# --- One-time setup, on the laptop ---
# 1. Keep a strong passphrase in a biometry-gated keychain bundle (the one key).
agents secrets generate 32 | agents secrets add release.key PASSPHRASE --value-stdin

# 2. Ship the release secrets to the remote as a file-backed bundle. The laptop
#    resolves them (one Touch ID) and forwards AGENTS_SECRETS_PASSPHRASE over
#    stdin (never argv) so the remote can encrypt them at rest.
export AGENTS_SECRETS_PASSPHRASE="$(agents secrets exec release.key -- printenv PASSPHRASE)"
agents secrets export apple.com    --host mac-mini --remote-backend file
agents secrets export rush.releases --host mac-mini --remote-backend file
unset AGENTS_SECRETS_PASSPHRASE

# --- Each release, from the laptop ---
# Read the passphrase (one Touch ID) and run the release on the remote. The
# passphrase reaches the remote process env, never its disk or argv.
P="$(agents secrets exec release.key -- printenv PASSPHRASE)"   # one Touch ID
ssh mac-mini 'AGENTS_SECRETS_PASSPHRASE=$(cat) \
  agents secrets exec rush.releases -- ./rush/app/scripts/release.sh 0.10.0 alpha.1 --yes' <<<"$P"
```

`$(cat)` reads the passphrase from ssh stdin so it never appears in the remote
process's argv / `ps`. The remote `agents secrets exec` decrypts the file-backed
bundle with it — no Touch ID, no GUI. (`codesign` itself still needs the Developer
ID identity in an unlocked keychain on the build host — a one-time `security
import` of the `.p12`, unrelated to `agents secrets`.)

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/secrets.mp4"></video>

`agents secrets create prod` then `agents secrets add prod STRIPE_API_KEY` — the key is stored in Keychain and injected automatically on `agents run --secrets prod`.

## Security model

The threat model `agents secrets` defends against is **on-disk plaintext exposure** — credentials in `.env` files, shell history, dotfiles, accidental git commits, backups. It does NOT defend a logged-in user from another binary running as that same user.

What the macOS Keychain ACL actually protects:

- Keychain items are written with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` plus an access control of `biometryCurrentSet OR devicePasscode`. Source: `src/lib/secrets/keychain-helper.swift:32-44`.
- That ACL is **user-presence**, not **code-identity**. The OS does not pin the item to the helper binary's code signature. Any same-user process that calls `SecItemCopyMatching` with the same service+account names and pops Touch ID (or the password sheet) gets the value.

The **`never` prompt-policy drops even the user-presence check.** A `never` bundle is stored *without* the biometry access control (`set-no-acl` in the helper uses a plain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and attaches no `kSecAttrAccessControl`), so reads are fully silent — no Touch ID, no broker, no user-presence gate at all. That means **any code running as your user reads it with zero interaction**, which is exactly the on-disk-plaintext-equivalent exposure the biometry ACL otherwise mitigates. Reserve `never` for low-sensitivity, automation-only credentials, and never put a high-value secret (signing keys, long-lived cloud tokens) in a `never` bundle. Creating or switching to `never` requires an explicit confirmation (`--i-understand`, or an interactive "are you sure" prompt) precisely because it is the global downgrade the rest of this model is built to avoid. See [Prompt policy and auto-cache](#prompt-policy-and-auto-cache) for the operational details.

Practical implications:

- A malicious binary running as your user, with you logged in at the keyboard, can read any bundle by popping Touch ID with a prompt that says "Unlock agents-cli secrets". Don't approve Touch ID prompts you didn't initiate.
- `agents secrets list` returns service names without prompting — service names are enumerable metadata. Don't name a bundle after a secret value.
- Bundle values injected via `agents secrets exec` or `agents run --secrets <bundle>` flow into the child process environment, which is inherited by every subprocess that child spawns (npm install scripts, shell commands, etc.). That's the documented feature — only put credentials in a bundle that you're OK letting the agent's full subprocess tree see.

What we don't protect against:

- Other same-user processes (you control your user account).
- A user who approves a Touch ID prompt for an attacker-controlled binary.
- Cross-user attacks where the attacker is `root` (the OS keychain is owned at user scope).

## The secrets-agent (macOS)

macOS pops a Touch ID prompt **per bundle, per process** — the biometry assertion is cached only within a single process and only for ~10s (Apple's cap), and macOS refuses "Always Allow" for items with a `kSecAccessControl`+biometry ACL. So running several agents concurrently (`agents teams`, or parallel `agents run --secrets`) re-prompts once per process. There is no OS setting to quiet this.

The secrets-agent is the ssh-agent answer:

- `agents secrets unlock <bundle>` reads the bundle from the keychain **once** (one Touch ID) and hands the resolved env to a small local broker that holds it in memory.
- Every later resolution of that bundle — by any `agents run`, teammate, browser profile, or the routines daemon — is served from the broker over a user-only Unix socket (dir `~/.agents/.cache/helpers/secrets-agent/`, mode `0700`). No prompt.
- The hold ends when its TTL expires (default 7d, `--ttl` to change), you run `agents secrets lock`, the machine sleeps, or you log out. A bare screen-lock does **not** drop it — the login password already gates a locked screen, and re-prompting after every lock would defeat the ~7-day window. Nothing is ever written to disk.

It is **opt-in by construction**: if you never run `unlock`, resolution is byte-for-byte today's keychain path. Audit events tag broker-served reads with `"source":"agent"` so you can tell them apart from real keychain reads.

### Persistent service

`agents secrets start` installs the broker as a **launchd user service** (`RunAtLoad` + `KeepAlive`, `ProcessType: Interactive`). Without it, the broker is cold-started on demand — and on a heavily loaded machine a freshly spawned process can't get scheduled to finish booting and bind its socket, so reads silently fall back to the keychain and prompt. The service starts **once** and stays up for the whole login session, so every read just connects. `agents secrets stop` removes it; `agents secrets status` shows whether it's installed. `unlock` and auto-cache install/kickstart it automatically, so first use sets it up.

### Self-healing across upgrades

A long-running daemon or broker keeps running the code it started with; an in-place `npm i -g` swaps the files but not the running process, so a fix can silently fail to take effect (e.g. a pre-fix daemon keeps reading the keychain). The agent self-heals onto new code with no per-read cost:

- **Heal-on-upgrade:** `postinstall` bounces the routines daemon and kickstarts the broker onto the just-installed code (best-effort; skip with `AGENTS_NO_HEAL=1`).
- **Version-skew detection:** the broker's `ping` reports the version of the code it's running; `ensureAgentRunning` restarts a stale broker, and a persistent broker self-exits on detecting an in-place upgrade so launchd relaunches it fresh.

### Prompt policy and auto-cache

Each bundle has a **prompt policy** that controls how often macOS asks for Touch ID, shown in the `POLICY` column of `agents secrets list` and set with `agents secrets policy <bundle> [daily|always]` (also `--policy` on `create`):

- **`daily`** (default): ask once, then hold it silently. The **first real keychain read auto-loads it** into the broker (in the background, no added latency), so the next concurrent run reads it silently without you running `unlock` at all — one Touch ID per ~7 days. Held from that unlock (not refreshed on use) — re-asks sooner after sleep, logout, or `lock`. A bare screen-lock does **not** drop it. Despite the name, it is **not** tied to one calendar day or one login session; it's the rolling ~7-day (1 week) hold — the name is historical, from when the window was ~24h.
- **`always`**: ask every time. Only an explicit `unlock` ever puts it in the agent; every other read pops Touch ID. Opt high-value bundles (signing keys, etc.) into this when you want to confirm every single read.
- **`never`**: stored **without** the biometry access control — reads are fully silent (no Touch ID, no broker, no user-presence check). This is the least-safe tier and is [documented in the security model](#security-model) as an on-disk-plaintext-equivalent downgrade: any code running as your user reads it with zero interaction. It is marked loudly (`never · NO ACL`, in red) in `agents secrets list` and `view`, and creating or switching to it requires an explicit confirmation — an interactive "are you sure" prompt, or `--i-understand` in a headless shell. Reserve it for low-sensitivity, automation-only credentials. Writing a `never` item needs a signed helper that carries the `set-no-acl` path; an older pinned helper rejects the write loudly rather than silently storing an `always`-style ACL'd item.

Change the **default** for all bundles globally in `agents.yaml` (`secrets.policy: always` to flip it back), or override per bundle with `agents secrets policy <bundle> always`. `never` is never a *default* — it can only be set explicitly per bundle, behind the confirmation gate.

> Wire-format note: the policy persists under the legacy `tier` key (`session` == `daily`, `biometry` == explicit `always`, `none` == `never`, absent == inherit the default) so bundles stay readable across mixed CLI versions on synced machines. `--tier`/`agents secrets tier` and the old `biometry`/`session`/`none` values still work as aliases. An older CLI that doesn't know `none` reads it as absent and falls back to its own default — safe, since it also lacks the no-ACL write path.

```yaml
# ~/.agents/agents.yaml
secrets:
  policy: daily   # default prompt policy for bundles without an explicit one (this IS the default)
  agent:
    auto: false   # opt OUT of daily-policy self-caching (on by default)
```

Auto-cache is **on by default** and only ever applies to `daily`-policy bundles — an `always` bundle is never auto-held, and a `never` bundle needs no agent at all (it is already silent). The `never` policy (items stored without the biometry ACL for fully silent reads with no broker) is the global downgrade the agent is otherwise designed to avoid, so it stays gated behind an explicit confirmation and a signed helper with the `set-no-acl` write path; see the [security model](#security-model). Tracked in [issue #421](https://github.com/phnx-labs/agents-cli/issues/421).

**The trade-off (read this):** while a bundle is unlocked, a same-user process that can reach the socket reads it **silently** — today it would at least have to pop a visible "Unlock agents-cli secrets" prompt you might notice. That is the same trust boundary the keychain already concedes above ("any same-user process can pop the prompt and read"), minus the prompt. Bound it by unlocking only the bundles you need, keeping a short TTL, locking when you step away, and never unlocking high-value bundles you'd rather always confirm.

Snapshot semantics: `unlock` stores the **resolved** env, so a bundle's dynamic refs (`exec:`, `env:`, `file:`) are frozen at unlock time until you re-unlock. Keychain and literal values — the overwhelming majority — are unaffected.

Source: `src/lib/secrets/agent.ts`. Auto-lock on sleep uses the signed keychain helper's `watch-lock` mode (`src/lib/secrets/keychain-helper.swift`) — a bare screen-lock does **not** wipe the hold (the login password already gates a locked screen); with an older helper that predates `watch-lock`, the agent degrades to TTL-only locking.

## Linux: headless servers and the encrypted-file fallback

On Linux, secrets are stored via `libsecret` / `secret-tool` (the GNOME Keyring
Secret Service). On a **headless server** there is no graphical login, so the
default keyring collection is **locked** and `secret-tool` can't write to it.
When that happens (or when `secret-tool` isn't installed), `agents secrets`
transparently falls back to an **AES-256-GCM encrypted-file store** under
`~/.agents/.cache/secrets/` (one `<item>.enc` file per secret, mode 0600).

The encryption key (passphrase) is resolved in this order:

1. **`AGENTS_SECRETS_PASSPHRASE`** — if set, always used. This is the way to
   keep the key **off disk** (e.g. exported from a password manager, or sourced
   into the shell per session). Recommended for shared/CI machines.
2. **An existing machine-local passphrase** — `~/.agents/.cache/secrets/.passphrase`
   (mode 0600), if one was provisioned earlier. Used for both interactive and
   headless runs so they always agree.
3. **A TTY prompt** — interactive sessions are asked for the passphrase.
4. **Auto-provisioned** — on a headless run (no TTY) with none of the above, a
   random passphrase is generated once and written to
   `~/.agents/.cache/secrets/.passphrase` (mode 0600). This is what makes
   `agents secrets` work out of the box on a server.

**Security model of the file store.** The auto-provisioned passphrase is
encryption-at-rest with the key held in a 0600 file — the same posture as an SSH
private key, and identical to the common `export AGENTS_SECRETS_PASSPHRASE=… ` in
`~/.zshenv` (chmod 600) workaround. It protects against on-disk plaintext
exposure (backups, accidental commits, `.env` leaks), not against another
process running as the same user. For a key held **off disk**, set
`AGENTS_SECRETS_PASSPHRASE` (it always takes precedence) or unlock the keyring
(e.g. configure `pam_gnome_keyring` for SSH login). To rotate, set a new
`AGENTS_SECRETS_PASSPHRASE`, re-add the secrets, and delete `.passphrase`.

## See Also

- `docs/00-concepts.md` — DotAgents repos and resource model
- `docs/profiles.md` — provider API keys for non-default models
- `docs/03-routines.md` — scheduled jobs with sandboxed permissions (secrets are dropped from the sandbox env by default)
