# Credential management — the fleet auth model

Status: design (target state). Companion to
[`secrets-trust-boundaries.md`](secrets-trust-boundaries.md).

## The problem

Every agent harness authenticates with a **rotating, interactive OAuth login**
stored on disk (Claude Code's `.claude/.credentials.json`, `.codex/auth.json`,
`.grok/auth.json`, `.kimi-code/…`, antigravity's Google token, droid's encrypted
blob). Measured on a live box, all of them are the same shape: a short-lived access
token plus a **single-use refresh token that rotates server-side on every refresh**.

Two failures follow from treating that login as fleet state:

1. **Fleet-wide logout.** `agents fleet apply` copies the login file across machines
   (`FLEET_AUTH_FILES`). When one box refreshes, the server rotates the refresh
   token and invalidates every other copy — the whole fleet drops to "run /login"
   (the codebase already documents this: `fleet/remote-login.ts` — "droid collapsed
   10 boxes → 1 overnight").
2. **Touch ID storm.** On macOS the login lives in the login Keychain, ACL-bound to
   the harness (Claude Code, etc.). agents-cli isn't on that ACL, so every time it
   reads the token — to draw `ag view` usage bars, to select an account — macOS
   pops a Touch ID sheet.

Both come from the same mistake: **agents-cli touching the interactive login.**

## The invariants (non-negotiable)

1. **The daemon holds no token.** No fallback, no injected, no per-account token. It
   never reuses a live/interactive token, never refreshes or rotates one, never logs
   in for the user. A routine runs the *exact same* `agents run` process a user runs
   directly. (Shipped: PR #1583.) See [`routines.md`](routines.md).

2. **The interactive/rotating login is untouchable.** agents-cli never reads,
   stores, syncs, or references a harness's interactive OAuth login. Not for usage,
   not for fleet sync, not for account selection. It is never written to the keychain
   by us and never copied across devices. It stays on the box that minted it and
   refreshes itself there. Enforced on the transfer paths too (RUSH-2527): neither
   `agents run --host --copy-creds` nor `agents run --lease` serializes a native
   login (Claude OAuth + codex/grok/gemini `auth.json`) to another device — both
   **refuse** and steer to a portable provider account, sharing the one
   `isNativeOAuthRuntime` predicate (`src/lib/hosts/credentials.ts` →
   `buildHostCredentialScript`, `src/lib/crabbox/runtimes.ts` →
   `buildCredentialScript`; SING-1b). Portable account bundles still cross the
   fleet through the explicit `agents accounts sync` path.

3. **The only credential agents-cli manages is a deliberate, durable credential.** A
   long-lived, **non-rotating** OAuth setup-token / API key / bearer token
   (`claude setup-token`, `OPENAI_API_KEY`, `XAI_API_KEY`, `FACTORY_API_KEY`, …).
   Valid until explicitly revoked → **safe to reuse on many devices, no repeated
   logouts, no revocation cascade.** That safety property is the whole reason it, and
   only it, is shareable.

4. **Shipped (RUSH-2470): each provider account is its own named `agents secrets`
   bundle, not one reserved bundle.** `agents accounts add <name> --provider <p>
   --auth <type>` creates a bundle named after the account, with secrets policy
   `never` set unconditionally — never the OS keychain's biometry ACL, so reading
   it raises no Touch ID prompt. There is no shared "auth" bundle name; a user can
   hold as many named accounts as they need, and only the accounts they explicitly
   `agents accounts sync <name> --device <device>` cross the fleet. That sync (and
   every `agents secrets` transport that moves credential bytes) rides a hardened
   SSH posture (RUSH-2527): the destination is verified against the CLI-managed
   known_hosts store — a **changed** host key is refused — and the credential
   connection is never multiplexed, so it leaves no reusable authenticated control
   master behind. Secret bytes cross on ssh **stdin** (push) / **stdout** (resolve),
   never on argv.

5. **Usage and account views read the setup-token**, not the interactive login —
   and never a prompting keychain read. Caveat (RUSH-2392): Anthropic's
   `claude setup-token` is scoped `user:inference` only; the usage endpoint
   requires `user:profile`. A setup-token therefore **cannot** populate usage
   bars — `agents view` renders `usage unavailable (headless)` (not
   `unverified` / `revoked`) so the gap is not mistaken for a re-mint need.
   Interactive login (device role `personal`, RUSH-2395) is the only path to
   live bars today. Cold/absent setup-token → "usage pending".

6. **Zero Touch ID** — `ag view`, agent launch, usage, any op — across **every
   harness**, including the hard ones (Droid, Kimi). Solution decided per credential
   *type*, not per agent name.

## One account namespace: provider credentials and named native logins (RUSH-2527)

An **account** is one authorization identity, and it comes in two kinds that share
a single name namespace (`meta.accounts`):

- **Provider credential accounts** — a durable API key, setup token, or bearer
  token the CLI stores as a policy-`never` secrets bundle (invariant 4 above).
  Created with `agents accounts add`; portable, so `accounts sync` copies it.
- **Native account records** — a durable *name* for a harness's own signed-in
  login. `agents accounts name <source> <name>` (e.g.
  `agents accounts name claude@2.1.220 work`) records **metadata only** — a stable
  id, the harness, the identity key, and a friendly label — in `meta.accounts.native`.
  The harness-owned OAuth/session credential is **never copied**, so a native
  account cannot be `sync`ed. A native lookup reads only `meta`, never the provider
  bundle store or the keychain.

**Only a safely-identifiable native login is nameable/attachable.**
`account-capabilities.ts` is the canonical table, and it is deliberately
conservative — a `NativeAccount` stores no device-id discriminator, so a login
whose identity can't be proven unique across synced metadata is marked
**unsupported** rather than falsely supported:

| Harness | Native account naming |
|---|---|
| Claude, Codex, Grok | **supported** — version-scoped, strong account key; attach to an exact `agent@version` |
| Muse | **conditional** — version-scoped, email-only; nameable only when the login exposes an email |
| Antigravity, Kimi, Droid, OpenCode | **unsupported** — device-scoped but opaque/singleton; the identity can't be proven distinct across devices (Droid exposes no account key; Antigravity/OpenCode can alias two credentials as one) |
| Cursor | **unsupported (blocked)** — multi-account isolation unresolved; use its API-key provider account instead |
| everything else | **unsupported** / discovery-only |

`agents accounts name`/`attach` refuse an unsupported harness with a named
reason (for example, `kimi accounts can't be isolated by agents-cli yet
(device-scoped login). Supported today: claude, codex, grok.`). That gate
applies only to native naming/attachment. Provider `accounts add <name>
--provider <p>` stays unrestricted. For a supported (version-scoped) login,
`attach` validates the target is currently signed in to the same identity
before binding, and injects no secret or env.

The commands read like the task, object first:

| Command | Behavior |
|---|---|
| `agents accounts` / `list` | Unified list: provider account bundles + named native logins |
| `agents accounts name <agent@version> <name>` | Name a signed-in native installation (refuses unsupported harnesses) |
| `agents accounts add <name> --provider <p> --auth <t>` | Store a provider credential account |
| `agents accounts view <account>` (alias `inspect`) | Show one account — kind, custody, and its attachments |
| `agents accounts attach <account> <target>` | Bind an account to a target. A **native** account attaches only to a supported `agent@version` installation. A **provider** account attaches to an `agent@version`, a bare harness id, or an existing custom-harness profile. Typos and unsupported targets are rejected before binding. |
| `agents accounts detach <account> <target>` | Remove one attachment |
| `agents accounts rename <old> <new>` / `remove <name>` | Rename or remove either kind; `remove` refuses while a binding, a per-harness default, or a harness profile still references the account |
| `agents accounts switch <harness> [account]` | Fast picker (or direct name) that writes the per-harness default. `--json` lists or reports. Same binding as `set-default`. |
| `agents accounts sync <account> <device>` | Copy a provider account bundle to a worker (native records have no bytes to copy) |

**Plan-tier account cap (RUSH-2424).** `agents accounts add` / `name` / `attach`
count the accounts (native + provider) already registered/usable for a harness
and refuse to add another before the plan's cap: **3 per harness on free, 10 on
paid/admin.** The tier comes from `apps/cli/src/lib/entitlement.ts`
(`GET /api/v1/billing/subscription?agent=agi-cli`, cached 15 minutes,
offline-tolerant — a stale cache is honored over a failed network call, and no
`~/.rush/user.yaml` at all resolves straight to free). A refusal at 3/3 free
reads `free plan is capped at 3 <harness> accounts (3/3). agents upgrade — up to
10 per harness.`; the add that lands exactly at 3/3 prints a one-line notice
instead of failing. **Downgrading never deletes a credential** — an account
past the new, lower cap simply falls out of `listSwitchableAccounts` (so
`accounts switch` / `set-default` never offer it) and is listed `dormant
(upgrade to reactivate)` in `agents accounts` until the plan is upgraded again.

`set-default` / `clear-default` remain the per-harness-default spelling and are
consulted after an exact `agent@version` or device-scoped binding.
`agents accounts switch <harness>` (optional `[account]`, `--json`) is the fast
picker over that same default: it lists named accounts with usage / headroom /
signed-out state and writes `set-default`. No extra persistent state.
`resolveAccountSelection` orders resolution: explicit `--account` → exact target
binding → device-scoped binding → per-harness default. Runtime injection of the
resolved account (live-fingerprint validation for native, env for provider) and
the fleet inventory labels are wired by the runtime/fleet-auth track; fleet
credential transport is owned by the credential-transport track.

## What is "held" and shared (the ingredients)

| ingredient | where | shared across fleet? | why safe |
|---|---|---|---|
| Interactive OAuth login | the box that minted it, in its own config home / the harness's own keychain item | **No — never touched by us** | rotates/revokes on cross-use; leaving it alone is the fix |
| Setup-token / API key (durable) | a named `agents accounts add` bundle, secrets policy `never` | **Yes — synced, explicitly** | non-rotating, revoke-only; reuse never invalidates another holder |
| daemon / CLI | — | — | hold nothing |

The only thing that crosses the fleet is a provider account bundle the user
deliberately created with `agents accounts add` and explicitly pushed with
`agents accounts sync <name> --device <device>`. Nothing rotating is ever copied.

## How each surface changes

- **`agents fleet apply`** does not copy login files. `FLEET_AUTH_FILES` is inventory
  metadata only; fleet apply has no native-login materialization path. Per
  agent per box `apply` surfaces: "logged in" / "log in on this box" (interactive or
  `agents fleet login`) / "add or sync a provider account (`agents accounts add` /
  `sync`)" — driven by whether the box has its own login or a declared account
  bundle, never by agent identity.
- **`agents fleet login`** (per-box device-code over SSH, writes the credential on
  the box, never transports it) stays as the per-machine login path. Onboarding a
  new device syncs the needed provider account bundle (`agents accounts sync`)
  instead of copying logins.
- **`ag view` / usage** (`usage.ts`) reads the setup-token from its named account
  bundle. It never reads the harness's ACL-bound keychain login. No no-ACL cache of
  the interactive token is needed because the interactive token is never read.
  When Anthropic returns 403 `user:profile` on that token, the probe sets
  `reason: 'usage_scope'` so auth-health stays `unverified` (not `revoked`) and
  the row shows `usage unavailable (headless)` (RUSH-2392).
- **Routines / `agents run`** authenticate via the box's own login (interactive) or
  the setup-token the user placed; the daemon injects nothing.

## Per-harness credential map (evidence-based, verified)

macOS keychain-ACL (→ Touch ID when we read it) is **claude + antigravity only**
(`auth-sync.ts:47`). Every other harness reads its login from a plain file and
**never triggers Touch ID** (`usage.ts` per-provider reads). Setup-token env vars
are already mapped in `profiles.ts:324-329` for BYOK profiles.

| harness | macOS login store | setup-token / API-key env var | wired in agents-cli? |
|---|---|---|---|
| claude | **keychain-ACL** | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, 1yr) / `ANTHROPIC_API_KEY` | daemon-inject removed (PR1); `ANTHROPIC_AUTH_TOKEN` via profiles; Linux shim reads `.oauth_token` |
| codex | file (`.codex/auth.json`) | `OPENAI_API_KEY` | yes (`profiles.ts:326`) |
| gemini | file | `GEMINI_API_KEY` | yes (`profiles.ts:327`) |
| grok | file | `XAI_API_KEY` | yes (`profiles.ts:328`) |
| opencode | file | `OPENCODE_API_KEY` | yes (`profiles.ts:329`) |
| droid | file (locally-decrypted, no keychain) | `FACTORY_API_KEY` (`fk-…`) | **no** — unwired anywhere |
| kimi | file (`.kimi-code/…`) | **none** — Kimi reads only `config.toml`, not env | **no** (not possible via env) |
| antigravity | **keychain-ACL** | `ANTIGRAVITY_API_KEY` (agents-cli claims; upstream issue #78 says unsupported — unresolved) | preset only |

Resolved open items:
- **Touch ID is Claude-only in practice.** Only claude routes usage/probe through
  the ACL keychain (`usage.ts:1305-1306`, `loadClaudeOauth`→`getKeychainToken`).
  Antigravity is keychain-bound but has NO usage read, so it doesn't hit the `ag
  view` storm. Droid & Kimi are already file-based → **no Touch ID to fix**.
- **Kimi has no env-var auth** (config.toml only) — a real limitation; its
  file-based OAuth login stays per-box, no shareable token.
- **Droid**: `FACTORY_API_KEY` is real but agents-cli wires nothing — a gap to
  close if we want droid selectable as an `agents accounts` provider.

## The Touch ID fix (concrete)

Only the **token-acquisition step** changes — no endpoint/header change (the usage
endpoint takes any `sk-ant-oat01-` bearer, `usage.ts:624,957`):

- In `loadClaudeOauth` (and its callers `probeClaudeStatus` / `getClaudeUsageInfo`,
  `usage.ts:604,938`), **resolve `CLAUDE_CODE_OAUTH_TOKEN` from the named account
  bundle (or env) BEFORE the keychain-ACL read** (`usage.ts:1348-1353`). If a
  setup-token is present → use it as the bearer and skip `getKeychainToken`
  entirely → no ACL-gated `/usr/bin/security` call → no Touch ID.
- Same for the daemon's every-3-min `probeLocalFleetAuth` (`auth-health.ts:391-410`)
  — the real storm source — so its warm loop reads the account bundle's
  setup-token, never the ACL-bound keychain login.
- The setup-token lives in a bundle written by `agents accounts add`, which
  always sets secrets policy `never` — a no-biometry-ACL item (keychain on
  macOS, the platform default elsewhere), never the harness's own ACL'd login.
  Populated by the user OR **self-minted** by the agent (`claude setup-token`
  via pty + computer-use).

## Migration (priority order — Touch ID first, it's the live pain)

1. Daemon holds nothing (done, #1583).
2. **Claude usage/probe read the account bundle's setup-token, not the ACL'd
   keychain login** → kills the Touch ID storm. Self-mint + store the setup-token
   per account. **Enforcement landed:** `loadClaudeOauth`'s `accessTokenCache`
   path (`usage.ts`) now returns `null` when no setup-token is provisioned
   instead of falling through to the interactive keychain / `.credentials.json`
   — so the daemon's usage (~60s) and auth-health (~3min) warms can never read
   or transmit the interactive OAuth login (the transitional fallback + its
   no-ACL cache are removed). An unprovisioned account reads as `unconfigured`
   (benign for rotation) and shows "usage pending"; seed a setup-token to
   restore usage. Rush Cloud dispatch does not read a Claude credential at all
   (SING-1b: the account manifest is version + email only). The leftover
   `readClaudeCredentialsBlob` helper that still read Keychain / `.credentials.json`
   — the #1767 shape — is deleted (RUSH-2359). `--lease` SING-1b detection reads
   the wrapped rotating blob itself and rejects anything that is not
   `{ claudeAiOauth.accessToken }`.
3. `apply` stops copying rotating login files (Gap B).
4. **Shipped (RUSH-2470):** `agents accounts add <name>` creates a named,
   policy-`never` bundle per account; `agents accounts sync <name> --device
   <device>` copies it explicitly to a worker device (encrypted file backend on
   Linux, Credential Manager on Windows). No reserved bundle name — every
   account the user creates is independently named and independently synced.
5. Fleet upgrade + verify **zero Touch ID** on a real macOS box (the proof).
