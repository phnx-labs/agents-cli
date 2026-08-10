---
kind: plan
template: plan.v1
surface: cli
title: Unify native logins and provider credentials as named accounts
summary: Give native OAuth identities and portable provider credentials one account catalog, then bind named accounts to native installations and custom harnesses with positional commands. Native OAuth remains owned by each harness and never enters the agents-cli keychain; portable secrets move only through an explicit, verified sync operation.
status: awaiting-go
tracking: "Account unification follow-up"
project: agents-cli
repository: phnx-labs/agents-cli
branch: main
harness: codex
agent: Codex
human: Owner
host: [worker]
session: 019fdef4
date: '2026-08-10'
facts:
  - Provider accounts already use canonical secrets bundles with stable UUIDs and policy never.
  - Native identities are currently discovered read-only and labels are not rendered in agents view.
  - Direct run, routines, custom harnesses, native installations, and fleet sync do not yet share one account resolver.
---

# Unify native logins and provider credentials as named accounts

## Focus for review

- Is the positional grammar natural: `name <source> <name>` and `attach <account> <target>`?
- Should a native OAuth alias be attachable only where that same harness-owned login already exists? This plan says yes.
- Should portable provider credentials be copied only by an explicit `accounts sync` command? This plan says yes.

## Intent

Manage a Claude, Codex, Cursor, or other native login separately from the installed CLI version, give it a memorable name such as `work`, and connect it to one or more installations. Use the same model for OpenRouter, DeepInfra, and other API-key or long-lived-token providers without making native OAuth credentials pass through agents-cli storage.

<div class="artifact-callout"><strong>Core rule:</strong> an account is a named identity. A native account stores only identity metadata and a binding to a harness-owned login. A provider account stores a portable credential in the existing secrets backend. Attaching never copies a native OAuth token.</div>

## Current architecture

<section class="artifact-grid artifact-grid-2">
<article class="artifact-panel" data-state="current" data-evidence="capture">
<figcaption><strong>Current:</strong> the name command reports success, but <code>agents view</code> still shows only the email and version.</figcaption>

```text
$ agents accounts name work --from claude@2.1.220
Named the claude account 'work'.

$ agents view claude
2.1.220  default  [account-redacted]
```
</article>

<article class="artifact-panel" data-state="proposed" data-evidence="mockup">
<figcaption><strong>Proposed:</strong> the source and target are positional, and the name is visible everywhere the identity appears.</figcaption>

```text
$ agents accounts name claude@2.1.220 work
Named claude@2.1.220 as work.

$ agents accounts attach work claude@2.1.225
Attached work to claude@2.1.225.

$ agents view claude
2.1.225  opus[1m]  work · [account-redacted]  Max
2.1.220  default   work · [account-redacted]  Max
```
</article>
</section>

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1040 350" role="img" aria-labelledby="account-title account-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="account-title">Unified account catalog and binding flow</title>
  <desc id="account-desc">Native aliases point to harness-owned OAuth state while provider accounts point to portable secret bundles. Both resolve through bindings to installations and custom harnesses.</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#a3e635"/></marker>
  </defs>
  <text x="30" y="28" fill="#a3e635" font-family="Inter,system-ui" font-size="14" font-weight="700">ACCOUNT CATALOG</text>
  <rect x="30" y="48" width="260" height="105" rx="12" fill="#111827" stroke="#a3e635" stroke-width="2"/><text x="50" y="79" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">native · work</text><text x="50" y="104" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">identity fingerprint + label</text><text x="50" y="128" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">secret stays in Claude/Codex/Cursor</text>
  <rect x="30" y="190" width="260" height="105" rx="12" fill="#111827" stroke="#a3e635" stroke-width="2"/><text x="50" y="221" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">provider · openrouter-work</text><text x="50" y="246" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">provider + auth type + stable UUID</text><text x="50" y="270" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">secret bundle, policy never</text>
  <path d="M290 100H405" stroke="#a3e635" stroke-width="3" fill="none" marker-end="url(#arrow)"/><path d="M290 242H405" stroke="#a3e635" stroke-width="3" fill="none" marker-end="url(#arrow)"/>
  <text x="420" y="28" fill="#a3e635" font-family="Inter,system-ui" font-size="14" font-weight="700">BINDINGS</text>
  <rect x="405" y="48" width="260" height="247" rx="12" fill="#111827" stroke="#475569" stroke-width="2"/><text x="430" y="84" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">work → claude@2.1.220</text><text x="430" y="121" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">work → claude@2.1.225</text><text x="430" y="176" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">openrouter-work → codex@0.145.0</text><text x="430" y="213" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">openrouter-work → cursor@latest</text><text x="430" y="268" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">openrouter-work → deepseek</text>
  <path d="M665 170H780" stroke="#a3e635" stroke-width="3" fill="none" marker-end="url(#arrow)"/>
  <text x="795" y="28" fill="#a3e635" font-family="Inter,system-ui" font-size="14" font-weight="700">EXECUTION</text>
  <rect x="780" y="48" width="230" height="247" rx="12" fill="#111827" stroke="#475569" stroke-width="2"/><text x="805" y="92" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">native installation</text><text x="805" y="120" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">validate existing login</text><text x="805" y="166" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">custom harness</text><text x="805" y="194" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">inject provider credential</text><text x="805" y="240" fill="#f8fafc" font-family="Inter,system-ui" font-size="15">remote fleet run</text><text x="805" y="268" fill="#cbd5e1" font-family="Inter,system-ui" font-size="12">resolve account on target</text>
</svg>
<figcaption>One catalog and one resolver, with different custody rules for native and portable credentials.</figcaption>
</figure>

## Purpose

The existing account work has two disconnected concepts. Provider credentials are durable account bundles, while native OAuth identities are read-only discovery rows. The old label path records a label outside the rendered catalog, so `agents view` cannot show it. Account selection also differs between direct runs, routines, custom harnesses, and remote dispatch.

The change standardizes the user model without pretending every harness supports the same authentication mechanics.

## Public Interface

### Command grammar

| Intent | Command | Meaning |
| --- | --- | --- |
| Name a discovered native login | `agents accounts name claude@2.1.220 work` | Create or update native account `work` from the login found in that installation |
| Add a portable provider credential | `agents accounts add openrouter-work --provider openrouter --auth api-key` | Create provider account and securely prompt for its key |
| Attach an account | `agents accounts attach work claude@2.1.225` | Bind the named account to an exact native installation |
| Attach to a custom harness | `agents accounts attach openrouter-work deepseek` | Bind the provider account to the named custom harness |
| Detach | `agents accounts detach work claude@2.1.225` | Remove exactly that binding |
| Inspect | `agents accounts view work` | Show identity metadata, credential custody, bindings, and availability |
| Rename | `agents accounts rename work rush-work` | Rename the account while retaining its stable ID and bindings |
| Remove | `agents accounts remove rush-work` | Refuse while bindings/defaults still reference it; explain how to detach |
| Copy portable credentials | `agents accounts sync openrouter-work [interactive-host]` | Explicitly provision the same stable provider account on another device |

`--from` and `--to` are removed from the proposed API. Flags remain for optional attributes and behavior, such as `--provider`, `--auth`, `--json`, `--force`, and `--default`.

### Complete happy paths

Native OAuth account:

```bash
agents accounts name claude@2.1.220 work
agents accounts attach work claude@2.1.225
agents accounts view work
agents run claude@2.1.225
```

Portable provider account:

```bash
agents accounts add openrouter-work --provider openrouter --auth api-key
agents accounts attach openrouter-work codex@0.145.0
agents accounts attach openrouter-work cursor@latest
agents accounts attach openrouter-work deepseek
agents accounts sync openrouter-work [interactive-host]
```

### Output contract

```text
$ agents accounts view work
work
  kind        native login
  identity    [account-redacted]
  provider    Anthropic
  custody     Claude Code (not stored by agents-cli)
  scope       version
  available   yes
  attached    claude@2.1.220, claude@2.1.225
```

```text
$ agents accounts view openrouter-work
openrouter-work
  kind        provider credential
  provider    OpenRouter
  auth        API key
  custody     agents secrets (no biometric ACL)
  available   this device, [interactive-host]
  attached    codex@0.145.0, cursor@latest, deepseek
```

Every human-readable account row uses `name · identity` when both exist. Every command that emits account data supports `--json` and returns the stable account ID, kind, display name, identity metadata, custody, availability, and bindings.

## Proposed Changes

### 1. One typed catalog, two credential custody models

Extend the existing account registry rather than add a second store:

```ts
type Account =
  | {
      id: string;
      name: string;
      kind: "native";
      agent: AgentId;
      identityKey: string;
      identityLabel?: string;
      authScope: "version" | "device";
    }
  | {
      id: string;
      name: string;
      kind: "provider";
      provider: AccountProviderId;
      authType: "api-key" | "token";
      bundle: string;
    };

type AccountBinding = {
  accountId: string;
  target: string;
};
```

Native records contain no OAuth access token, refresh token, auth file, or keychain reference. Provider records continue to use the canonical secrets bundle with stable UUID and `policy: never`.

### 2. One target parser and resolver

Parse the second positional argument into either an exact native installation (`claude@2.1.225`, `codex@0.145.0`, `cursor@latest`) or a custom harness (`deepseek`). Resolve accounts in this order:

1. explicit run account;
2. exact target binding;
3. bare-agent default;
4. current native or balanced selection.

The same resolver is used by direct runs, routines, teams, local dispatch, and remote fleet dispatch. Cloud/lease runs fail clearly for device-local native accounts. They do not export native OAuth automatically.

### 3. Capability registry keeps harness claims truthful

| Capability | Harnesses / handling |
| --- | --- |
| Version-scoped native identity | Claude, Codex, Grok; Muse when identity inspection is strong |
| Device-scoped native identity | Cursor after correcting false XDG isolation; Antigravity, Kimi, Droid, OpenCode where their auth is device-global |
| Requires inspector work before attach | Copilot |
| Discovery only / legacy | Gemini |
| Unsupported until modeled | Pi, OpenClaw, Amp, Kiro, Goose, Hermes, Warp |
| Portable provider credential | Registry-driven adapters only; unsupported provider/harness pairs fail loud |

For a native account, `attach` validates that the target already exposes the same identity fingerprint. It never logs in, copies, or rewrites OAuth state. A device-scoped harness rejects an exact-version attachment and explains that the account applies to the device.

### 4. Labels render everywhere

Use one account renderer in `accounts`, `agents view`, `harness view`, run banners, pickers, routines, and fleet inventory. Recover archived fingerprint labels transactionally where the identity still matches. Do not auto-merge opaque identities.

### 5. Explicit and verifiable portable sync

`accounts sync <account> <device>` applies only to provider accounts. The destination import is one atomic transaction with rollback and read-back verification. Transport requirements:

- pinned managed SSH host key; reject unknown or changed keys;
- no SSH multiplex reuse for the credential transfer;
- secret bytes only on stdin, never argv, environment, logs, or config;
- no persistent plaintext or reusable secret fingerprint;
- same name with a different stable account ID fails unless explicitly forced;
- macOS uses a silent, non-biometric Keychain item; Linux uses the encrypted file backend; Windows uses Credential Manager.

Sync provisions the same logical account ID on another device. Attaching one account to several harnesses does not clone it into several logical accounts.

### 6. No Touch ID noise in normal operation

Normal `accounts`, `view`, routing, attachment validation, and usage inspection read only native metadata or provider bundle metadata. They never read native OAuth secrets. Provider accounts use non-biometric secret policy, so headless execution does not trigger Touch ID. A secret read occurs only when launching a harness that requires the selected portable credential or during explicit sync.

## Plan

- [ ] Add native account metadata and binding schema; migrate matching archived labels.
- [ ] Replace relationship flags with positional `name`, `attach`, `detach`, `view`, and `sync` grammars plus workflow-first help.
- [ ] Add the capability registry and identity validation for every supported native harness.
- [ ] Route custom harnesses, native installations, direct runs, routines, teams, and SSH dispatch through one account resolver.
- [ ] Render names, custody, availability, and bindings consistently in text and JSON.
- [ ] Remove ordinary cloud/lease native OAuth export and enforce device-local errors.
- [ ] Harden provider sync with pinned hosts, atomic import, rollback, and equality verification.
- [ ] Update CLI docs, specifications, README, CHANGELOG, and audit companion `.agents-system` consumers.
- [ ] Run focused account tests, full remote tests, and installed-CLI E2E on macOS, Linux, and Windows credential backends.

## Validation

| Scenario | Required result |
| --- | --- |
| Name Claude login | `accounts view work` and `agents view claude` show `work · email` |
| Attach native alias to matching login | Binding succeeds without reading or copying OAuth secrets |
| Attach native alias to different identity | Nonzero error names both identities; no state changes |
| Attach provider to Codex/Cursor/custom harness | Each installed target resolves the same stable provider account |
| Normal view/routing | No biometric prompt and no native secret access |
| Remote run | Destination resolves the account locally; no implicit secret transfer |
| Explicit provider sync | Atomic destination import verifies and reports availability on both devices |
| Native sync attempt | Refused with `native login credentials remain owned by <harness>` |
| Unsupported harness | Clear nonzero capability error, never a silent no-op |

```bash
cd apps/cli
./scripts/build.sh --skip-tests
bun run test:remote
agents accounts name claude@2.1.220 work
agents accounts attach work claude@2.1.225
agents accounts view work --json
agents view claude
```

## Risks

| Risk | Handling |
| --- | --- |
| A label points at the wrong human identity | Bind by stable fingerprint; never email text alone; opaque identities do not auto-merge |
| Cursor isolation is overstated | Mark Cursor device-scoped until its runtime behavior is corrected and verified |
| Removing `--from` / `--to` breaks unreleased examples | Change code, help, docs, and companion guidance together; do not add a compatibility shim unless a shipped version requires it |
| Account removal leaves dangling consumers | Refuse removal while bindings, defaults, profiles, harnesses, or routines reference the ID |
| Sync exposes a reusable credential | Explicit command only, pinned transport, stdin-only atomic import, no native OAuth path |
| Provider adapter claims exceed real support | Registry completeness tests pin every supported pair and require clear unsupported errors |

## Tracking

The implementation should use one account-unification ticket and link this rendered plan from that ticket. Any prerequisite harness inspector work should be a linked subtask and referenced back here before implementation begins.

## Delta Spec

- Account names MUST be unique across native and provider accounts and MUST resolve through stable IDs.
- `accounts name <source> <name>` MUST create only native metadata and MUST NOT read or store native OAuth credentials.
- `accounts attach <account> <target>` MUST use positional arguments and MUST validate compatibility before changing bindings.
- A native attachment MUST reference a harness-owned login already present at the target scope; it MUST NOT migrate credentials.
- A provider attachment MAY bind one portable account to multiple compatible native installations and custom harnesses.
- Normal inspection, routing, and status commands MUST NOT trigger biometric prompts.
- Portable credential sync MUST be explicit, destination-authenticated, atomic, rollback-safe, and verifiable without persisting plaintext.
- Remote execution MUST resolve the account on the destination. It MUST NOT transfer credentials implicitly.
- Text and JSON account renderers MUST expose the same account identity, custody, availability, and binding facts.
- Unsupported harness or provider combinations MUST fail nonzero with the missing capability named.
