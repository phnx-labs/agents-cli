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

1. **Fleet-wide logout.** `agents apply` copies the login file across machines
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
   directly. (Shipped: PR #1583.) See [`03-routines.md`](../../apps/cli/docs/03-routines.md).

2. **The interactive/rotating login is untouchable.** agents-cli never reads,
   stores, syncs, or references a harness's interactive OAuth login. Not for usage,
   not for fleet sync, not for account selection. It is never written to the keychain
   by us and never copied across devices. It stays on the box that minted it and
   refreshes itself there.

3. **The only credential agents-cli manages is a deliberate setup-token.** A
   long-lived, **non-rotating** OAuth setup-token / device-login token / API key
   (`claude setup-token`, `OPENAI_API_KEY`, `XAI_API_KEY`, `FACTORY_API_KEY`, …).
   Valid until explicitly revoked → **safe to reuse on many devices, no repeated
   logouts, no revocation cascade.** That safety property is the whole reason it, and
   only it, is shareable.

4. **Setup-tokens live file-based, in a reserved "auth" bundle.** They are stored in
   the **file-based** secrets mechanism (never the OS keychain), under a reserved
   bundle name (the `auth` bundle), and synced across the fleet by the existing
   file-based secrets sync. No Touch ID, because no keychain ACL.

5. **Usage and account views read the setup-token**, not the interactive login. `ag
   view`'s usage bars are drawn from the file-based setup-token. Cold/absent → show
   "usage pending", never a prompting keychain read.

6. **Zero Touch ID** — `ag view`, agent launch, usage, any op — across **every
   harness**, including the hard ones (Droid, Kimi). Solution decided per credential
   *type*, not per agent name.

## What is "held" and shared (the ingredients)

| ingredient | where | shared across fleet? | why safe |
|---|---|---|---|
| Interactive OAuth login | the box that minted it, in its own config home / the harness's own keychain item | **No — never touched by us** | rotates/revokes on cross-use; leaving it alone is the fix |
| Setup-token (API key / long-lived OAuth) | file-based `auth` secrets bundle | **Yes — synced** | non-rotating, revoke-only; reuse never invalidates another holder |
| daemon / CLI | — | — | hold nothing |

The only thing that crosses the fleet is the reserved `auth` bundle (file-based
setup-tokens the user deliberately placed). Nothing rotating is ever copied.

## How each surface changes

- **`agents apply`** stops copying login files. `FLEET_AUTH_FILES` loses its copy
  role; the `push-login` / `--recv-auth` login-materialize path is removed. Per
  agent per box `apply` surfaces: "logged in" / "log in on this box" (interactive or
  `agents fleet login`) / "seed the `auth` bundle" — driven by whether the box has
  its own login or a declared setup-token, never by agent identity.
- **`agents fleet login`** (per-box device-code over SSH, writes the credential on
  the box, never transports it) stays as the per-machine login path. Onboarding a
  new device seeds the reserved `auth` bundle instead of copying logins.
- **`ag view` / usage** (`usage.ts`) reads the setup-token from the file-based `auth`
  bundle. It never reads the harness's ACL-bound keychain login. No no-ACL cache of
  the interactive token is needed because the interactive token is never read.
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
  close if we want droid in the `auth` bundle.

## The Touch ID fix (concrete)

Only the **token-acquisition step** changes — no endpoint/header change (the usage
endpoint takes any `sk-ant-oat01-` bearer, `usage.ts:624,957`):

- In `loadClaudeOauth` (and its callers `probeClaudeStatus` / `getClaudeUsageInfo`,
  `usage.ts:604,938`), **resolve `CLAUDE_CODE_OAUTH_TOKEN` from the file-based `auth`
  bundle (or env) BEFORE the keychain read** (`usage.ts:1348-1353`). If a setup-token
  is present → use it as the bearer and skip `getKeychainToken` entirely → no
  `/usr/bin/security` call → no Touch ID.
- Same for the daemon's every-3-min `probeLocalFleetAuth` (`auth-health.ts:391-410`)
  — the real storm source — so its warm loop reads the file-based setup-token, never
  the keychain.
- The setup-token lives in a **file-based** bundle (`--backend file`,
  `~/.agents/.cache/secrets/`, no biometry). Populated by the user OR **self-minted**
  by the agent (`claude setup-token` via pty + computer-use), stored file-backed.

## Migration (priority order — Touch ID first, it's the live pain)

1. Daemon holds nothing (done, #1583).
2. **Claude usage/probe read the file-based setup-token, not the keychain** → kills
   the Touch ID storm. Self-mint + store the setup-token per account file-based.
3. `apply` stops copying rotating login files (Gap B).
4. Reserved file-based `auth` bundle + fleet sync (via `vault.age`/`secrets
   push-pull`, not `apply`) — onboarding + headless.
5. Fleet upgrade + verify **zero Touch ID** on a real macOS box (the proof).
