---
kind: report
title: "Accounts UX + provisioning audit — `agents accounts` / `agents view`"
summary: "Design audit of the account surface: presentation, verb overlap, expiry detection, and per-harness provisioning, bound to PHNX-3940 (fleet account state inconsistent across machines). Every claim is grounded in code (file:line) and real command output captured 2026-09-06."
project: AGI
repository: phnx-labs/agents-cli
branch: docs/accounts-ux-audit
status: awaiting-review
harness: kimi
host: laptop
date: 2026-09-06
tracking: PHNX-3940
links:
  - "https://linear.app/getrush/issue/PHNX-3940"
  - "https://linear.app/getrush/issue/PHNX-3887"
  - "https://linear.app/getrush/issue/PHNX-3988"
  - "https://linear.app/getrush/issue/PHNX-3728"
---

# Accounts UX + provisioning audit (PHNX-3940)

**Scope.** The `agents accounts` / `agents view` account surface of `@phnx-labs/agents-cli`, audited at commit `f9e36d645` (branch `docs/accounts-ux-audit`, based on `origin/main`). Read-only research — no source changed. Emails are redacted (`m***@gmail.com`), device names are replaced by role aliases (`laptop`, `worker-1`…`worker-6`), and identity ids are truncated, because this artifact is committed to a public repo.

**Method.** Ran the read-only surfaces on the laptop (`agents accounts list`, `agents accounts list --json`, `agents accounts --fleet`, `agents view claude|codex`, `agents view claude --json`, `agents view --versions`, `agents accounts --help`) and read the implementation: `cli/src/commands/accounts.ts`, `cli/src/commands/view.ts`, `cli/src/lib/account-registry.ts`, `cli/src/lib/account-catalog.ts`, `cli/src/lib/auth-health.ts`, `cli/src/lib/agent-spec/agents.ts`, `cli/src/lib/signin-badge.ts`, `cli/src/lib/devices/doctor-findings.ts`, `cli/src/lib/daemon/*`, `cli/docs/credential-management.md`.

## Summary

- **`connected` is file presence, not health.** The real health vocabulary (`authVerdict`: live/revoked/expired/rate_limited/unverified, `cli/src/lib/auth-health.ts:50-57`) exists and is maintained by the daemon, but no human surface renders it — expired logins are silent unless a routine happens to fire on the dead account.
- **Recommendation (Q1):** a status-table redesign (Design A, §1.4) with `STATE`, `WHERE`, and `FIX` columns, an attention-first header, and a fleet matrix (Design C) for `--fleet` — all renderable from data the CLI already computes.
- **Verbs (Q2):** 17 verbs fold to 15 — `name` is a subset of `label`, `switch` is `set-default` with a picker; `<harness>#<name>` addressing (PHNX-3988) should extend to label/rename/remove.
- **Provisioning (Q4):** uniform `accounts add` + `accounts sync` only for provider-API-key harnesses; claude has mint + daemon sync; kimi/antigravity are per-box by design; droid is documented-but-unwired; copilot/openclaw/hermes/goose/warp are UNVERIFIED.
- **PHNX-3940 root cause:** device-scoped native rows and connect homes deliberately never sync (`account-registry.ts:294-310`), producing the cross-machine label drift captured live in §5.

## Evidence

Raw command captures appear inline where they are discussed: the `agents accounts list` capture in §1.1, the `agents view claude` capture in §1.2, the `agents view claude --json` observations in §3.2, and the `agents accounts --fleet` capture in §5. Every behavioral claim carries a `file:line` citation against commit `f9e36d645`. Anything not confirmable from code or output is marked **UNVERIFIED** rather than guessed (§4 tail rows, §3.3 copilot/openclaw/hermes/goose).

---

## 1. Presentation — what exists today, and how it should be designed

### 1.1 What `agents accounts list` prints today (real output, redacted)

```
Native logins     run <harness>#<label>
  antigravity  —             antigravity:sub=1257…e7a7                connected
  claude       personal    * m***@gmail.com                           connected
               dev           d***@getrush.ai                          connected
               work          m***@getrush.ai                          connected
               trp           m***@trp.so                              connected
               icloud        m***@icloud.com                          connected
               swarm         s***@swarmify.co                         connected
               smores        t***@agentsmores.com                     connected
               prix          t***@prix.dev                            connected
  codex        gmail       * m***@gmail.com                           connected
               codex-icloud  m***@icloud.com                          connected
               codex-smores  t***@agentsmores.com                     connected
  cursor       —           * m***@gmail.com                           connected
  droid        —           * m***@getrush.ai                          connected
  grok         zeff          z***@gmail.com                           connected
               —           * m***@icloud.com                          connected
  kimi         —           * kimi:user=d483…1gtg                      connected
  muse         —           * m***@gmail.com                           connected
  opencode     —           * opencode:providers=meta+openai+opencode-go  not connected here

  * default account for that harness (used when you pass neither @version nor #label)

Provider bundles  run <harness> --account <name>
  claude-d***-getrush              anthropic   setup-token  ready
  claude-m***-getrush              anthropic   setup-token  ready
  claude-m***-trp-so               anthropic   setup-token  ready
  claude-m***-gmail-com            anthropic   setup-token  ready
  claude-m***-icloud-com           anthropic   setup-token  ready
  claude-s***-swarmify-co          anthropic   setup-token  ready
  claude-t***-prix-dev             anthropic   setup-token  ready
  legacy-openrouter-45a642fc       openrouter  api-key      ready
```

The renderer is `renderAccountList` (`cli/src/commands/accounts.ts:167-219`): the `Native logins` header is at `accounts.ts:174`, each row is `harness | label | * | identity | state` assembled at `accounts.ts:198`, the default `*` is decided at `accounts.ts:194` (catalog `isDefault`, else "account's versions include the global default version"), and the state column at `accounts.ts:197` is **binary** — `connected` vs `not connected here` — mapped from the catalog's `connected` / `reconnect-needed` (`cli/src/lib/account-catalog.ts:220,255`), which is pure **credential-file presence**, not liveness. Provider rows (`accounts.ts:210-216`) print `name | provider | auth | ready/missing on this device` — "missing on this device" is the only device-flavored string in the entire local list.

### 1.2 What `agents view <harness>` prints today (real output, redacted)

```
Agents and accounts

  Claude · automatic updates on
    * personal · m***@gmail.com  connected  claude-fable-5-1[1m]  Max  S: ▊░░░░ 15% (4h)     W: █▎░░░ 24% (5d)
      dev · d***@getrush.ai      connected  opus[1m]  Max  S: █▎░░░ 24% · stale (period ended 18m ago)  W: █▎░░░ 26% · stale (period ended 2h ago)  unverified
      work · m***@getrush.ai     connected  claude-opus-4-8  Max  S: ▌░░░░ 9% · 5h old  W: ▎░░░░ 5% (2d)
      ...
      smores · t***@agentsmores.com  connected  opus[1m]  Max  S: ┄┄┄┄┄ unavailable  W: █▍░░░ 27% · 7d old  unverified

  Connect: agents accounts connect claude [name] · Details: agents view claude --versions
```

Row assembly is at `cli/src/commands/view.ts:702-710` (account-first) and `view.ts:807-891` (`--versions`); usage bars come from `formatUsageSummary` (`cli/src/lib/accounting/usage.ts:966-1068`), and the `stale` / `unverified` / `unavailable` markers from `usage.ts:2932-2969`, `usage.ts:1049-1050`, and `usage.ts:1016,1058-1064` respectively.

### 1.3 The five at-a-glance questions, graded against today's output

| Question | Answerable today? | Why |
|---|---|---|
| Which accounts exist per harness? | **Yes** | both surfaces group by harness |
| Which is default? | **Mostly** | `*` exists, but it can lie: the catalog computes `isDefault` from `meta.accounts.defaults` first (`account-catalog.ts:227-230`), while `agents run` checks device/central **bindings before** the default (`account-registry.ts:507-512`) — a binding silently outranks the starred row with no visual indication |
| Signed in / expired / rate-limited? | **No** | `connected` = file exists, nothing more (§3). The daemon-maintained `authVerdict` (`live`/`revoked`/`expired`/`rate_limited`/`unverified`, `cli/src/lib/auth-health.ts:50-57`) is rendered **nowhere** in human output — only in `view --json` (`view.ts:1614-1615`) and the `devices ping` matrix (`cli/src/commands/ssh.ts:1216-1252`) |
| Which live on which device? | **No** | `accounts list` is strictly local (`accounts.ts:151-163`) with no `--device` flag (`accounts.ts:542-544`); `view -D` runs the whole command remotely, it does not merge (`view.ts:2156`, `cli/src/lib/hosts/option.ts:16-25`). The only fleet render is `agents accounts --fleet` → `runDevicesAccounts` (`ssh.ts:1162-1181`, matrix at `cli/src/lib/devices/harness-inventory.ts:362-382`) — a separate command with a different row shape |
| What to run to fix a problem? | **Barely** | the only fix hints anywhere are the `Connect:` footer in `view` and the `(logged out — log in with: …)` line for fully logged-out installs (`view.ts:867-871`); `expired`/`revoked`/`unverified` states carry **no** remediation text |

### 1.4 Redesign proposals

All three mockups are monochrome-safe (text + box-drawing only, no color semantics) and monospace.

**Design A — status table: one row per account, `STATE` and `FIX` columns.**

```
accounts · laptop · 2026-09-06 10:05 local
HARNESS  ACCOUNT   IDENTITY            STATE        WHERE             FIX
claude * personal  m***@gmail.com      live         laptop,worker-1   —
claude   dev       d***@getrush.ai     live         laptop            —
claude   prix      t***@prix.dev       unverified   laptop            agents view claude --refresh
claude   (2.1.245) —                   logged out   laptop            agents run claude@2.1.245, then /login
codex  * gmail     m***@gmail.com      rate-limited laptop            wait · resets 6d
codex    cxpersonal m***@gmail.com     —            worker-2          label differs per device (PHNX-3940)
grok   * —         m***@icloud.com     live         laptop,worker-5   —
opencode —         meta+openai+…       not here     worker-5          agents accounts connect opencode
```

One flat table, sorted harness → default-first → state. Every question answered in the row: existence, default (`*`), health (`STATE`), location (`WHERE`), remediation (`FIX`). `STATE` is the existing `authVerdict` vocabulary — zero new concepts.

**Design B — attention queue on top, inventory below.**

```
accounts — 3 need attention
  x  claude#(2.1.245)   logged out, 8d        fix: agents run claude@2.1.245, then /login
  !  claude#prix        auth unverified, 7d   fix: agents view claude --refresh
  !  opencode           not connected here    fix: agents accounts connect opencode

claude — default: personal
  * personal   m***@gmail.com   live   Max  S 15% (4h)  W 24% (5d)
    dev        d***@getrush.ai  live   Max  S 24% · stale 18m
    prix       t***@prix.dev    ???    Max  W 25% · 7d old
codex — default: gmail
  * gmail      m***@gmail.com   429    Pro  W 59% (6d)
```

Ranks by progress/attention (the repo's own principle: not-progressing work surfaces first). Healthy accounts collapse to one line; problems get a queue with the fix inline. Costs a second layout mode.

**Design C — fleet matrix (the `--fleet` shape).**

```
accounts --fleet — claude
ACCOUNT   laptop      worker-1    worker-3    worker-5
personal  live        live        live        live
dev       live        signed out  —           live
prix      unverified  —           —           —
trp       live        —           live        —
          fix: agents accounts connect claude dev -D worker-1
```

Identity rows × device columns, cell = authVerdict. This is the shape that directly answers PHNX-3940 ("fleet account state inconsistent across machines"): a ragged row *is* the inconsistency. It replaces today's per-host blocks (§5) where the same question requires scanning six lists.

**Recommendation: Design A for the local default, with B's attention block as a conditional header, and C as the `--fleet` shape.** A alone answers all five questions in one scan with the existing `authVerdict` vocabulary; the attention block (shown only when ≥1 account is not `live`) satisfies the "problems first" principle without a second layout; C is the same table pivoted for the fleet. All three render from data the CLI already computes — `authVerdict` cache (`auth-health.ts:315-317`), the native catalog (`account-catalog.ts`), the fleet harness inventory (`harness-inventory.ts:362-382`) — so this is a presentation change, not a new detection pipeline.

### 1.5 Current vs proposed, side by side

<table>
<tr><th>Today (<code>agents accounts list</code>)</th><th>Proposed (Design A + attention header)</th></tr>
<tr><td><pre>
Native logins     run &lt;harness&gt;#&lt;label&gt;
  claude  personal * m***@gmail.com   connected
          dev        d***@getrush.ai  connected
          prix       t***@prix.dev    connected
  codex   gmail    * m***@gmail.com   connected
  opencode —       * id:meta+…        not connected here

Provider bundles  run &lt;harness&gt; --account &lt;name&gt;
  claude-m***-gmail-com  anthropic  setup-token  ready
</pre></td><td><pre>
accounts — 2 need attention
  x claude#(2.1.245)  logged out   fix: agents run claude@2.1.245, then /login
  ! opencode          not here     fix: agents accounts connect opencode

HARNESS  ACCOUNT  IDENTITY         STATE       WHERE    FIX
claude * personal m***@gmail.com   live        laptop   —
claude   dev      d***@getrush.ai  live        laptop   —
claude   prix     t***@prix.dev    unverified  laptop   view claude --refresh
codex  * gmail    m***@gmail.com   rate-lim.   laptop   wait · 6d
bundle claude-m***-gmail-com       ready       laptop   sync → worker-2
</pre></td></tr>
</table>

Key deltas: `connected` (file presence) → real verdicts (`live`/`unverified`/`rate-limited`/`logged out`); a `WHERE` column; a `FIX` column on every non-healthy row; provider bundles folded into the same table instead of a second block with a different selection syntax.

---

## 2. Verbs — rename / label / name / switch / set-default / attach

All subcommands are registered in `cli/src/commands/accounts.ts` (`registerAccountsCommand`, `accounts.ts:535`), except `mint` (`cli/src/commands/auth-mint.ts:48`).

### 2.1 What each verb actually does

| Verb | Definition | Behavior |
|---|---|---|
| `name <source> <name>` | `accounts.ts:646-655` | **Requires `<harness>@<version>`** — `parseInstallation` throws otherwise (`accounts.ts:48-54`). Reads the install's signed-in identity, creates a native account row (metadata only, no credential copy) via `addNativeAccount` (`account-registry.ts:280-315`). Fails if the identity is already named (`account-registry.ts:290-291`). |
| `label <source> [label]` | `accounts.ts:657-669` | Accepts a bare `<harness>` **or** `<harness>@<version>` (`runAccountsLabel`, `accounts.ts:295-329`); binds the label to the `(agent, identityKey)` **identity**, not the version, so it survives version moves (`labelNativeAccount`, `account-registry.ts:318-348`). No label arg defaults to the email (`account-registry.ts:325`). |
| `rename <old> <new>` | `accounts.ts:756-758` | Pure name change preserving the stable id, for **both** kinds: sweeps native rows for the identity + rewrites defaults, or renames the provider secrets bundle (`renameAccount`, `account-registry.ts:562-605`). Does not re-resolve identity. |
| `set-default <agent> <name>` | `accounts.ts:763-770` | Writes `meta.accounts.defaults[agent] = name` — by **name, not id**, because defaults sync fleet-wide and ids are per-device (`setDefaultAccount`, `accounts.ts:370-391`; comment at `accounts.ts:385-388`). |
| `switch <harness> [account]` | `accounts.ts:772-777` | With an account arg, calls **the same** `setDefaultAccount` (`accounts.ts:419,450`); without, opens an interactive picker (`pickSwitchAccount`, `cli/src/lib/run-account-picker.ts:225`). Help says it itself: "`accounts switch` is the fast picker over the same default `set-default` writes" (`accounts.ts:894`). |
| `clear-default <agent>` | `accounts.ts:779-791` | Deletes `meta.accounts.defaults[agent]` (`accounts.ts:784-788`). Does **not** touch bindings. |
| `attach <account> <target>` | `accounts.ts:671-731` | Writes `bindings[target] = account.id` (target = `agent@version` / harness / profile) into the central or device doc (`bindAccount`, `account-registry.ts:437-460`); also seeds Linux-worker `.oauth_token` (`accounts.ts:104-124`). |
| `detach <account> <target>` | `accounts.ts:733-754` | Deletes one binding row (`unbindAccount`, `account-registry.ts:462-485`). |
| `logout <target>` | `accounts.ts:793-834` | Signs out a harness-native login; the **only** verb accepting `<harness>#<name>` today (`parseLogoutTarget`, `accounts.ts:460-472`). Steers provider accounts to `remove` (`accounts.ts:797-802`). |
| `sync <name> [device]` | `accounts.ts:836-866` | **Provider bundles only**, one-directional local → one device over SSH (`pushBundleToHost`, `cli/src/lib/secrets/push.ts:305`). A native name errors "Unknown provider account" (`accounts.ts:844-845`). |

### 2.2 Overlaps and confusion points (all evidence-backed)

1. **`name` is a stricter subset of `label`.** Both create native-account rows and both reject duplicates; `name` only adds the `@version` requirement. Its help ("without copying its OAuth credentials", `accounts.ts:647`) never says when to prefer it over `label`.
2. **`switch` ≡ `set-default`.** Identical write path; only the picker differs. Two verbs, one write.
3. **Uniqueness is per-harness at creation but fleet-wide at rename.** Native labels are unique per harness (PHNX-3887, `account-registry.ts:227-242`), but management lookups without a harness in hand keep the old fleet-wide check (`account-registry.ts:236-238,568`) — so `accounts rename` can fail on a collision that `accounts label` would have allowed. PHNX-3988 (in flight) makes rename/remove accept `<harness>#<name>`, which supplies the missing harness and resolves this.
4. **`clear-default` does not return you to "native".** A binding written by `attach` still outranks the cleared default at run time (selection order `account-registry.ts:496-514`), so after `clear-default` an attached account still wins — the help text ("Return a harness to native login or balanced account selection", `accounts.ts:780`) overpromises.
5. **Three propagation mechanisms, no single "make machine X match" verb**: `sync` (provider bundle push), `mint --fleet` (mint-time fan-out, `auth-mint.ts:57-58`), `agents repo push/pull` (labels/defaults/bindings metadata, `accounts.ts:385-388,668`).
6. **`logout` / `remove` / `detach` are routinely conflated** — the guards prove it: `logout` rejects provider accounts with a pointer to `remove` (`accounts.ts:797-802`), and `remove` refuses while still attached (`account-registry.ts:611-612`).

### 2.3 Proposed minimal verb set

Ten verbs, grouped by task in help. Fold two, keep the rest:

- **Inspect:** `list`, `view` (unchanged)
- **Create:** `connect` (native login), `add` / `set-key` / `mint` (provider bundles)
- **Name:** **`label` only** — fold `name` into it (already a subset); once PHNX-3988 lands, `label`/`rename`/`remove` all take `<harness>#<name>` so the per-harness namespace (PHNX-3887) is addressable everywhere
- **Rename:** `rename` — anything, id-preserving (fix its uniqueness check to per-harness when the target carries a harness)
- **Select:** `set-default` / `clear-default`; **`switch` becomes an alias** for `set-default` with no args = picker (one write path, one documented verb)
- **Bind:** `attach` / `detach` (advanced; long-term could become `set-default --for <target>`)
- **Teardown:** `logout` (native credential), `remove` (record + bundle)
- **Propagate:** `sync` — extend beyond provider bundles into the single "make device X match" verb (§5)

Net change: **17 → 15 verbs** (`name` and `switch` folded), one naming mental model (`label` creates, `rename` changes), one default model (`set-default`), and `#`-addressing everywhere.

---

## 3. Re-auth and expiry — how the CLI knows, what the user sees

### 3.1 The detection pipeline, layer by layer

**Layer 1 — file presence (synchronous, every render).** `credentialPresence(agentId, versionHome)` (`cli/src/lib/agent-spec/agents.ts:1635-1641`; `cli/src/lib/agents.ts` is a 2-line facade at `agents.ts:1-2`) checks first-existing credential files from `CREDENTIAL_FILE_SEGMENTS` (`agents.ts:1565-1580`): claude `.claude/.claude.json` / `.claude.json` (gated by `!isClaudeCredentialFileBlank`, `agents.ts:1601`, because `.claude.json` is metadata not credential — PHNX-3502), codex `.codex/auth.json`, gemini `.gemini/google_accounts.json`, grok `.grok/auth.json`, kimi `.kimi-code/credentials/kimi-code.json`, droid `.factory/auth.v2.file`, antigravity `…/antigravity-oauth-token`, opencode `.local/share/opencode/auth.json`, muse `.config/muse/auth.json`, cursor `.cursor/auth.json`. Only harnesses in `ACCOUNT_INSPECTION_AGENT_IDS` (`agents.ts:1480-1491`: claude, codex, gemini, cursor, grok, antigravity, kimi, droid, opencode, muse) can yield a logout claim at all. **copilot, openclaw, hermes, goose, warp have no known credential location — the CLI cannot even guess their auth state.**

**Layer 2 — doctor findings (provable vs unprovable).** `signInToFindings` (`cli/src/lib/devices/doctor-findings.ts:951-983`): provable logout (both file locations absent **and** `knownLocation`) → kind `logged-out`, severity **critical**, message exactly `logged out — no account signed in` (`doctor-findings.ts:971`); unprovable → kind `logout-unprovable`, severity **warning**, message `could not verify sign-in` (`doctor-findings.ts:977`). Remediation text is per `loginShape` (`doctor-findings.ts:255-285`): codex/grok → `agents run <agent>@<version> -- login`, opencode → `-- auth login`, claude → `agents run <agent>@<version>, then /login`, everything else → `agents run <agent>@<version>`.

**Layer 3 — network probes (daemon, cached).** Only **claude, kimi, droid** have live probes (`LIVE_PROBE_AGENTS`, `cli/src/lib/auth-health.ts:73`). The daemon's `AccountAuthService` ticks every **3 min** and `AccountUsageService` every **60 s** (`cli/src/lib/daemon/account-state-daemon-service.ts:28-30`), probing deduped per (agent, account) (`auth-health.ts:522-538`) and writing `.auth-health.json` (`auth-health.ts:315-317`). Verdict vocabulary (`auth-health.ts:50-57`): `live` (2xx, or a fresh <20 min usage fetch, `auth-health.ts:421-432`), `revoked` (401/403 — except Claude setup-token `user:profile` 403s → `unverified`, RUSH-2392, `auth-health.ts:94`), `expired` (local `exp`/JWT check only, no network — claude `usage.ts:1753`, kimi `usage.ts:1812`, droid `usage.ts:1841`), `rate_limited` (429), `unverified` (credential present but no probe endpoint — codex/grok/everyone else), `unconfigured` (no usable credential), `error` (indeterminate; never clobbers a prior verdict, `auth-health.ts:363-373`).

**Layer 4 — consumers.** Rotation excludes fresh `revoked` accounts (`cli/src/lib/accounting/rotate.ts:375-378`); routine fire-time blocks `revoked` + `unconfigured` and owner-notifies (`cli/src/lib/routine-readiness.ts:41-43`, `cli/src/lib/daemon/daemon.ts:1204-1211`); `agents run` prints an advisory — `"<agent> looks logged out — sign in with: <hint>. Launching anyway..."` (`cli/src/commands/exec.ts:3080-3088`). The `loginHint` map is `cli/src/lib/signin-badge.ts:23-39`.

### 3.2 What the user actually sees when a login dies — mostly nothing

Real evidence from `agents view claude --json` captured today:

- `claude@2.1.225` (icloud account) carries `"authVerdict": "rate_limited"` — yet the human `agents view claude` renders that row as plain `connected` with healthy-looking bars. **The human surface has no authVerdict chip anywhere.**
- `claude@2.1.245` shows `"signedIn": false, "launchable": false` **and** `"authVerdict": "live"` with an `authCheckedAt` ~8 days stale — the cached verdict outlives the logout it contradicts, and only the `--versions` render notices: `(logged out — log in with: claude, then /login)` (`view.ts:867-871`).

So the complete list of surfaces where a dead login is visible:

| Surface | Shows | Proactive? |
|---|---|---|
| `agents view` human | `connected` (file presence) + `logged out` line only when identity is gone (`view.ts:867-871`) | no |
| `agents view --json` | `authVerdict` + `authCheckedAt` (`view.ts:1614-1615`) | no — pull only |
| `agents accounts list` | binary `connected` / `not connected here` (`accounts.ts:197`) | no |
| `agents doctor` | critical `logged out — no account signed in` / warning `could not verify sign-in` (`doctor-findings.ts:971,977`) | no — pull only |
| `agents devices ping` | fleet auth matrix with `N revoked — re-login` notes (`ssh.ts:1216-1252`) | no — pull only |
| routine fire blocked | terminal `blocked`/`agent_auth_failed` + owner notification (`routine-readiness.ts:58-67`, `daemon.ts:1204-1211`) | **yes — the only push path** |
| `agents run` | one advisory line, then launches anyway (`exec.ts:3080-3088`) | at run time only |

**The silent gap:** the daemon writes verdict transitions to a cache but raises **no notification on the transition itself** — verified: no notify call in `account-state-daemon-service.ts`, `daemon-ticks.ts`, or `auth-health.ts`. A login can die at 02:00 and the owner finds out when a routine fails or when they happen to run `devices ping`. And for the ~70% of harnesses without a live probe (everything but claude/kimi/droid), even the cache can never say better than `unverified`.

### 3.3 Re-auth command per harness (when a login dies)

From `loginHint` (`signin-badge.ts:23-39`), doctor remediations (`doctor-findings.ts:255-285`), and `accounts connect` (`cli/src/lib/accounts/connect.ts:59-62`):

| Harness | Re-auth command | Notes |
|---|---|---|
| claude | `agents accounts connect claude [name]` (drives `claude auth login`) or `agents run claude@<ver>`, then `/login` | headed device: native OAuth only, never the setup-token (invariant 7) |
| codex | `agents accounts connect codex [name]` or `agents run codex@<ver> -- login` | `connect` is wired for **claude and codex only** (`connect.ts:59-62`) |
| grok | `agents run grok@<ver> -- login` | |
| opencode | `agents run opencode@<ver> -- auth login` | |
| gemini, kimi, droid, cursor, antigravity, muse, warp | `agents run <agent>@<ver>` (device/OAuth flow on launch) | per `loginHint` default arm (`signin-badge.ts:36-38`) |
| copilot, openclaw, hermes, goose | **UNVERIFIED** — no inspection, no hint, no findings | outside `ACCOUNT_INSPECTION_AGENT_IDS` |

---

## 4. Provisioning to workers — the per-harness matrix

The owner rule (`cli/docs/credential-management.md:98-132`, invariant 7): headed devices authenticate with the harness's **normal interactive OAuth, minted on that device**; workers authenticate with the **durable long-term credential synced from the account bundle**; minting happens on the personal laptop (`agents accounts mint claude` is the intended one-shot, lines 118-124); a dead login on a headed device is fixed by **re-running native OAuth, never by falling back to the setup-token** (lines 126-132). The provisioning model (`credential-management.md:134-175`) splits harnesses into **token-bearing → mint-once-on-laptop, copy + auto-inject** and **token-less → log in per box** (`agents fleet login`).

Grounding facts: `agents auth mint` and `agents accounts mint` are the **same command**, registered once (`cli/src/commands/auth-mint.ts:48`, mounted on `agents auth` at `cli/src/commands/auth.ts:161`) and **claude-only** — `MINT_FLOWS` has exactly one entry (`cli/src/lib/auth-mint.ts:71-81`), every other harness fails loud with a steer to `fleet login` or `accounts add` (`auth-mint.ts:99-106`, and the "lying table" comment at `:66-70`). `accounts sync` copies **provider bundles only** (`accounts.ts:836-866`). The daemon `auth-sync` service (15-min tick, `cli/src/lib/daemon/auth-sync-service.ts:12`) propagates **exactly one thing**: the reserved file-backed `auth` bundle holding claude setup-tokens, to peers whose shared verdict says `missing` (`cli/src/lib/secrets/reserved-sync.ts:125-201`). Native OAuth file propagation exists as a table (`FLEET_AUTH_FILES`, `cli/src/lib/fleet/auth-sync.ts:26-37`) but is **disabled fleet-wide** — `isCredentialSafeToPropagate` returns `false` unconditionally (`auth-sync.ts:64-66`).

| Harness | Interactive login happens | Durable credential kind | Exact copy-to-worker command | Expiry detection | Status |
|---|---|---|---|---|---|
| **claude** | laptop, `claude auth login` / `accounts connect` | setup-token (1 yr), seeded as named provider account + reserved `auth` bundle (`auth-mint.ts:227-278`) | `agents accounts mint claude --fleet` (or `--device`), else `agents accounts sync <name> <device>`; reserved bundle auto-syncs via daemon | live probe: 401/403 → `revoked`, local `exp` check → `expired` (`usage.ts:1753`) | **implemented** |
| **codex** | laptop, `codex login` / `accounts connect` | provider API key (`OPENAI_API_KEY`, `profiles.ts:462-468`) as `accounts add --provider openai` bundle | `agents accounts sync <name> <device>` | no live probe — `unverified` at best; file presence only | **implemented** (API-key path); native OAuth not portable |
| **gemini** | per box (deprecated — retired 2026-06-18, `agents.ts:407-418`) | `GEMINI_API_KEY` bundle | `agents accounts sync <name> <device>` | no probe; credential file known (`agents.ts:1568`) | implemented but **harness deprecated**; successor is antigravity |
| **antigravity** | **per box** — keychain-bound OAuth, no portable key (`credential-management.md:164-170`) | `ANTIGRAVITY_API_KEY` adapter exists (`account-provider-registry.ts:76`) but upstream issue #78 says unsupported — **unresolved** (`credential-management.md:306`) | none sanctioned — `agents fleet login` per box | none — opaque credential, `signed in` is advisory (`signin-badge.ts:6-9`) | **documented-only / unresolved** |
| **grok** | laptop, `grok login` | `XAI_API_KEY` bundle | `agents accounts sync <name> <device>` | no live probe — `unverified` | **implemented** (API-key path) |
| **opencode** | laptop, `opencode auth login` | `OPENCODE_API_KEY` bundle | `agents accounts sync <name> <device>` | no live probe; file presence (`agents.ts:1573`) | **implemented** (API-key path) |
| **droid** | laptop, device-code on launch | `FACTORY_API_KEY` — **documented but unwired anywhere** (`credential-management.md:304`); no `factory` provider adapter exists (`account-provider-registry.ts:55-85`); native auth files are single-use/rotating (`auth-sync.ts:51`) | none — UNVERIFIED beyond the doc | live probe exists (`LIVE_PROBE_AGENTS`, `auth-health.ts:73`; `usage.ts:1836-1841`) | **documented-only** for provisioning; detection implemented |
| **kimi** | **per box** — no env auth possible, `config.toml` only (`credential-management.md:305,313-314`) | none | none possible — `agents fleet login` per box | live probe exists (`auth-health.ts:73`, `usage.ts:1799-1812`) | **implemented** (per-box login is the design, not a gap) |
| **cursor** | laptop (OAuth) | `CURSOR_API_KEY` adapter exists (`account-provider-registry.ts:61`) | `agents accounts sync <name> <device>` (as a provider account) | file presence only when `AGENT_CLI_CREDENTIAL_STORE=file` (`agents.ts:1577-1579`); no probe | **partially implemented** |
| **copilot** | UNVERIFIED — registry entry carries no auth statement (`agents.ts:537`) | none known | none | none — no credential location known | **UNVERIFIED** |
| **openclaw** | UNVERIFIED (`agents.ts:496`) | none known | none | none | **UNVERIFIED** |
| **hermes** | config at `~/.hermes/config.yaml` (`agents.ts:883-901`); auth mechanism UNVERIFIED | none known | none | none | **UNVERIFIED** |
| **muse** | laptop — `META_API_KEY` or browser OAuth at `~/.config/muse/auth.json` (`agents.ts:948,967`) | `META_API_KEY` env mentioned in registry; no provider adapter host entry | none wired — UNVERIFIED | file presence only (`agents.ts:1574-1576`) | **partially implemented** |
| **goose** | unmanaged — offered via `agents import goose` | none known | none | none | **UNVERIFIED** |
| **warp** | interactive browser sign-in on launch, or `WARP_API_KEY` / `--api-key` (`agents.ts:1021-1022`) | `WARP_API_KEY` documented in registry but **no adapter maps it** | none wired | none — no credential location known | **documented-only** |

Cross-cutting: provider API-key bundles for codex/gemini/grok/opencode/cursor all ride the same two commands (`accounts add` + `accounts sync`), so the "copy to worker" story is uniform **except** claude (mint + reserved bundle + daemon), the token-less pair (kimi, antigravity → per-box `fleet login`), and the unwired/unknown tail (droid, copilot, openclaw, hermes, muse, goose, warp). Also found: the doc's native-naming table (`credential-management.md:199-209`) disagrees with the code on cursor and kimi — the code marks both `status: 'supported'` (`cli/src/lib/account-capabilities.ts:41,43`) and the doc itself declares the code canonical (`:194`). The doc is stale.

---

## 5. Fleet inconsistency — the PHNX-3940 evidence

`agents accounts --fleet` today (real output, redacted; full capture in the PR session). Note three inconsistency classes visible in one screen:

```
Fleet accounts
  laptop
      personal · m***@gmail.com       claude   yes  24%*   ready
      gmail · m***@gmail.com          codex    yes  59%*   ready
      codex-icloud · m***@icloud.com  codex    yes  37%*   ready
      codex-smores · t***@...         codex    yes  26%*   ready
      ...
  worker-1
      personal · m***@gmail.com       claude   yes  20%*   ready
      signed out                      antigravity, claude, codex, grok, openclaw   no  —  signed out
      cxpersonal · m***@gmail.com     codex    yes  no credits   out of credits
  worker-2
      cxicloud · m***@icloud.com      codex    yes  no credits   out of credits
      cxpersonal · m***@gmail.com     codex    yes  no credits   out of credits
      cxsmores · t***@...             codex    yes  —          ready
  worker-3
      signed out                      codex, openclaw   no  —  signed out
      ...
```

1. **Label drift**: the same codex identity is `gmail` on the laptop but `cxpersonal` on worker-1/2/5; `codex-icloud` vs `cxicloud`; `codex-smores` vs `cxsmores`. Root cause in code: labels/defaults live in the central meta synced by `agents repo push/pull` (`accounts.ts:385-388`), but **device-scoped** native rows and connect homes deliberately do **not** sync (`account-registry.ts:294-310,350-371`; `cli/src/lib/devices/device-docs.ts:156-159` states there is no cross-box union of `deviceAccounts`) — and worker mints/labels were applied per-box.
2. **Per-device signed-out blocks**: `signed out — antigravity, claude, codex, grok, openclaw` on worker-1, while the same harnesses are `ready` on the laptop — expected for token-less harnesses (per-box login is the design) but indistinguishable in this render from a *broken* token-bearing sync.
3. **Health you can't act on**: `out of credits` / `no credits` rows carry no fix hint; the render (`renderAccountsMatrix`, `cli/src/lib/devices/harness-inventory.ts:362-382`) is a per-host dump, not a matrix, so answering "is codex#personal consistent across the fleet?" means diffing six lists by eye. That is exactly the question Design C (§1.4) answers in one row.

---

## 6. Account lifecycle — state diagram

Edges carry the exact command (or daemon event) that drives the transition. This is the lifecycle as implemented today, including the two silent edges (`expired` detection and the un-synced device scope) that PHNX-3940 is about.

<svg viewBox="0 0 960 430" xmlns="http://www.w3.org/2000/svg" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="none" stroke="currentColor">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="currentColor" stroke-width="1.4"/>
    </marker>
  </defs>

  <!-- states -->
  <g stroke-width="1.4">
    <rect x="30"  y="180" width="110" height="40" rx="6"/>
    <rect x="220" y="180" width="110" height="40" rx="6"/>
    <rect x="410" y="80"  width="110" height="40" rx="6"/>
    <rect x="410" y="280" width="110" height="40" rx="6"/>
    <rect x="590" y="180" width="120" height="40" rx="6"/>
    <rect x="800" y="180" width="120" height="40" rx="6"/>
  </g>
  <g fill="currentColor" stroke="none" text-anchor="middle" font-size="13">
    <text x="85"  y="204">no login</text>
    <text x="275" y="204">connected</text>
    <text x="465" y="104">labelled</text>
    <text x="465" y="304">default</text>
    <text x="650" y="198">expired /</text>
    <text x="650" y="213">revoked</text>
    <text x="860" y="204">removed</text>
  </g>

  <!-- edges -->
  <g stroke-width="1.3" marker-end="url(#arr)">
    <path d="M 140 200 H 214"/>
    <path d="M 330 186 C 380 150 380 130 404 112"/>
    <path d="M 330 214 C 380 250 380 270 404 288"/>
    <path d="M 520 300 C 560 280 560 130 524 106"/>
    <path d="M 330 200 C 440 200 500 200 584 200"/>
    <path d="M 590 190 C 500 150 420 160 336 188"/>
    <path d="M 710 200 H 794"/>
    <path d="M 800 224 C 500 260 220 250 96 224"/>
  </g>

  <!-- edge labels -->
  <g fill="currentColor" stroke="none" font-size="11">
    <text x="150" y="192">accounts connect &lt;harness&gt; [name]</text>
    <text x="345" y="140">accounts label &lt;harness&gt; [name]</text>
    <text x="345" y="272">accounts set-default &lt;h&gt; &lt;name&gt;</text>
    <text x="536" y="262">accounts clear-default &lt;h&gt;</text>
    <text x="420" y="192">daemon probe: 401/403 → revoked · local exp → expired</text>
    <text x="420" y="206" opacity="0.65">(auth-health.ts:80-97 · silent — no notification)</text>
    <text x="360" y="160">re-auth: accounts connect &lt;h&gt; &lt;name&gt; · agents run &lt;h&gt;@&lt;ver&gt; -- login</text>
    <text x="716" y="192">accounts logout / remove</text>
    <text x="300" y="252">accounts remove (any state)</text>
  </g>

  <!-- sync note -->
  <g fill="currentColor" stroke="none" font-size="11" opacity="0.75">
    <text x="30" y="40">cross-device: labels/defaults sync via `agents repo push/pull` (accounts.ts:385-388) · device-scoped rows + connect homes never sync (account-registry.ts:294-310) ← PHNX-3940</text>
    <text x="30" y="58">claude setup-token: `accounts mint claude --fleet` or daemon auth-sync (15 min) → workers · native OAuth files: propagation disabled (fleet/auth-sync.ts:64-66)</text>
  </g>
</svg>

---

## Findings

Each finding is actionable and cited.

1. **`connected` is a file-existence claim rendered as a health claim.** `accounts.ts:197` + `account-catalog.ts:220,255`. The real health vocabulary already exists (`authVerdict`, `auth-health.ts:50-57`) but reaches humans only via `devices ping` (`ssh.ts:1216-1252`). → Render the verdict in `accounts list` and `view` (Design A).
2. **Expired/revoked logins are silent.** The daemon detects and caches them but never notifies on transition (no notify call in `account-state-daemon-service.ts`/`daemon-ticks.ts`/`auth-health.ts`); only a blocked routine notifies (`daemon.ts:1204-1211`). → Notify on `live→revoked|expired` transitions.
3. **No fix hints except for fully-logged-out installs.** `view.ts:867-871` is the only remediation string; `expired`/`revoked`/`unverified`/`not connected here` states have none. → A `FIX` column driven by the existing `loginHint` (`signin-badge.ts:23-39`) + doctor remediations (`doctor-findings.ts:255-285`).
4. **The `*` default can diverge from what `agents run` launches** when a binding exists (`account-catalog.ts:227-230` vs `account-registry.ts:507-512`). → Render bound targets distinctly from the default.
5. **Verb overlap**: `name` ⊂ `label`; `switch` ≡ `set-default`; rename-time uniqueness is fleet-wide while creation-time is per-harness (`account-registry.ts:236-238` vs `:227-242`, PHNX-3887). → Fold to the §2.3 set; `<harness>#<name>` everywhere once PHNX-3988 lands.
6. **Fleet inconsistency is by construction**: device-scoped rows and connect homes never sync (`account-registry.ts:294-310`, `device-docs.ts:156-159`), producing the label drift observed in §5 (`gmail` vs `cxpersonal` for one identity). → One "make device X match" verb + the Design C matrix to see it.
7. **Provisioning is uniform only for provider-API-key harnesses.** claude has mint + daemon sync (implemented); codex/gemini/grok/opencode/cursor have add + sync (implemented); kimi/antigravity are per-box by design; droid's `FACTORY_API_KEY` is documented-but-unwired (`credential-management.md:304`); copilot/openclaw/hermes/goose/warp are UNVERIFIED with no credential knowledge in the codebase at all.
8. **Doc drift**: `credential-management.md:199-209` marks cursor and kimi naming unsupported; the code it calls canonical says supported (`account-capabilities.ts:41,43`).

*Audit produced 2026-09-06 on branch `docs/accounts-ux-audit`. Refs PHNX-3940. Related: PHNX-3887 (per-harness name uniqueness), PHNX-3988 (`<harness>#<name>` addressing, in flight), PHNX-3728 (fully automatic save+propagate+inject).*
