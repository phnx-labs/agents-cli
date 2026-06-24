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

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/secrets.mp4"></video>

`agents secrets create prod` then `agents secrets add prod STRIPE_API_KEY` — the key is stored in Keychain and injected automatically on `agents run --secrets prod`.

## Security model

The threat model `agents secrets` defends against is **on-disk plaintext exposure** — credentials in `.env` files, shell history, dotfiles, accidental git commits, backups. It does NOT defend a logged-in user from another binary running as that same user.

What the macOS Keychain ACL actually protects:

- Keychain items are written with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` plus an access control of `biometryCurrentSet OR devicePasscode`. Source: `src/lib/secrets/keychain-helper.swift:32-44`.
- That ACL is **user-presence**, not **code-identity**. The OS does not pin the item to the helper binary's code signature. Any same-user process that calls `SecItemCopyMatching` with the same service+account names and pops Touch ID (or the password sheet) gets the value.

Practical implications:

- A malicious binary running as your user, with you logged in at the keyboard, can read any bundle by popping Touch ID with a prompt that says "Unlock agents-cli secrets". Don't approve Touch ID prompts you didn't initiate.
- `agents secrets list` returns service names without prompting — service names are enumerable metadata. Don't name a bundle after a secret value.
- Bundle values injected via `agents secrets exec` or `agents run --secrets <bundle>` flow into the child process environment, which is inherited by every subprocess that child spawns (npm install scripts, shell commands, etc.). That's the documented feature — only put credentials in a bundle that you're OK letting the agent's full subprocess tree see.

What we don't protect against:

- Other same-user processes (you control your user account).
- A user who approves a Touch ID prompt for an attacker-controlled binary.
- Cross-user attacks where the attacker is `root` (the OS keychain is owned at user scope).

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
