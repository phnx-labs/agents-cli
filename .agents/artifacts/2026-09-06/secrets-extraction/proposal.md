---
kind: plan
surface: cli
title: Secrets CLI — independent stores, portable bundles
summary: Keep named bundles and safe injection; remove fleet, harness and daemon ownership from the reusable package.
status: proposed
project: agents-cli
repository: phnx-labs/agents-cli
harness: codex
agent: Codex
host: withheld
human: owner
session: withheld
date: "2026-09-06"
tracking: PHNX-3989
links:
  - https://github.com/phnx-labs/agi-cli/pull/3499
  - https://linear.app/getrush/issue/PHNX-3989
  - https://linear.app/getrush/issue/PHNX-3975
assets:
  - op-docs.jpg
  - aws-docs.jpg
---

## Focus for review

- Extract the engine completely; keep a process client in agents-cli.
- Use explicit provider bindings, with native authentication.
- Separate remote secret source from command execution location.

## Purpose

**Yes: extract the implementation into a standalone package with its own CLI, SDK and release. Keep only the integration client and agent/fleet policy in agents-cli.** The chosen repository is `phnx-labs/secrets-cli`, the product is **Secrets CLI**, and the executable is `secrets`. The proposed npm package is `@phnx-labs/secrets-cli`; repository/package creation and runtime extraction are future implementation.

This is a design deliverable. No secret stores, credentials or runtime behavior were changed. The screenshot's “keep” verdict establishes neither a packaging requirement nor an extraction boundary. The feature can remain useful while its implementation leaves the CLI.

<div class="artifact-callout">The important split is <strong>bundle format → secret provider → child process</strong>. A device is an execution or transport choice. It does not belong in the bundle format.</div>

<figure class="artifact-figure artifact-behavior">
<section class="artifact-panel" data-state="current" data-evidence="mockup"><h3>Today: agents is required · current behavior reconstructed from code</h3><pre><code>agents secrets exec prod -- ./deploy.sh
agents secrets exec prod --device worker -- ./deploy.sh
# Second command fetches remotely, runs locally.</code></pre></section>
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>After: usable without agents-cli · proposed CLI mockup</h3><pre><code>secrets exec prod -- ./deploy.sh
secrets exec prod --host worker -- ./deploy.sh
# Same local child; source is now explicit.</code></pre></section>
</figure>

## Current architecture

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide"><svg class="artifact-diagram" viewBox="0 0 960 350" role="img" aria-label="Current: secrets code reaches back into the CLI"><defs><marker id="a350" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8"/></marker></defs><path d="M280 80 L355 80" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a350)"/><text x="324.5" y="72.0" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12">calls</text><path d="M625 80 L700 80" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a350)"/><text x="669.5" y="72.0" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12">reads</text><path d="M490 130 L490 230" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a350)"/><text x="497.0" y="172.0" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12">imports</text><rect x="30" y="30" width="250" height="100" rx="8" fill="#11191c" stroke="#f59e0b" stroke-width="1.5"/><text x="46" y="58" fill="#f59e0b" font-family="Inter, sans-serif" font-size="17">Callers</text><text x="46" y="82" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">run · accounts · browser</text><text x="46" y="101" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">profiles · share · SSH</text><rect x="355" y="30" width="270" height="100" rx="8" fill="#11191c" stroke="#f59e0b" stroke-width="1.5"/><text x="371" y="58" fill="#f59e0b" font-family="Inter, sans-serif" font-size="17">Secrets inside agents-cli</text><text x="371" y="82" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">commands + bundles + stores</text><text x="371" y="101" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">grants + helper + crypto</text><rect x="700" y="30" width="230" height="100" rx="8" fill="#11191c" stroke="#a3e635" stroke-width="1.5"/><text x="716" y="58" fill="#a3e635" font-family="Inter, sans-serif" font-size="17">OS / encrypted stores</text><text x="716" y="82" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">Keychain · file · age</text><text x="716" y="101" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">libsecret · Credential Manager</text><rect x="355" y="230" width="270" height="95" rx="8" fill="#11191c" stroke="#38bdf8" stroke-width="1.5"/><text x="371" y="258" fill="#38bdf8" font-family="Inter, sans-serif" font-size="17">Agents infrastructure</text><text x="371" y="282" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">daemon · feed · state</text><text x="371" y="301" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">hosts · registry · resource filters</text></svg><figcaption>Current: secrets code reaches back into the CLI</figcaption></figure>

The current storage union is `keychain | file | vault`; its internal `ItemStore` already batches reads. References currently support `keychain`, `env`, `file`, and `exec`. 1Password is currently an import/export integration, not a live reference provider. Reuse these seams, but make network resolution asynchronous. [cli/src/lib/secrets/bundles.ts:51](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/bundles.ts#L51) · [cli/src/lib/secrets/index.ts:119](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/index.ts#L119) · [cli/src/lib/onepassword.ts:1](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/onepassword.ts#L1).

| Audited surface | Physical lines, including comments/blanks | Scope |
|---|---:|---|
| Secrets library TypeScript | 11,748 | 33 non-test `.ts` files under `cli/src/lib/secrets/` |
| Secrets command TypeScript | 4,055 | 6 non-test `commands/secrets*.ts` files |
| Combined inventory | 15,803 | Excludes Swift, tests, setup, 1Password and external consumers |

As of 2026-09-06, commit `f33fdfc45604`. These are inventory counts, **not promised deleted lines or package-byte savings**. The original census uses a different grouping. [Raw per-file records and consumer inventory](inventory.json) accompany this plan; its appendix explains the counting recipe.

The command imports SSH and host resolution; bundle resolution imports resource filters, state and feed; low-level keychain reads can start the agents daemon. Removing just the command would leave the engine inside agents-cli. [cli/src/commands/secrets.ts:16](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/commands/secrets.ts#L16) · [cli/src/lib/secrets/bundles.ts:41](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/bundles.ts#L41) · [cli/src/lib/secrets/index.ts:88](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/index.ts#L88).

## The proposed boundary

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide"><svg class="artifact-diagram" viewBox="0 0 960 545" role="img" aria-label="Proposed: one-way integration; providers and remote execution stay distinct"><defs><marker id="a545" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8"/></marker></defs><path d="M220 125 L340 205" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a545)"/><text x="287.0" y="157.0" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12">exec / SDK</text><path d="M775 125 L605 205" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a545)"/><text x="697.0" y="157.0" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12">private pipe</text><path d="M355 310 L230 405" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a545)"/><text x="299.5" y="349.5" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12">storage</text><path d="M475 310 L475 405" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a545)"/><text x="482.0" y="349.5" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12">resolve</text><path d="M625 310 L760 405" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a545)"/><text x="699.5" y="349.5" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12">remote source</text><rect x="25" y="20" width="270" height="105" rx="8" fill="#11191c" stroke="#a3e635" stroke-width="1.5"/><text x="41" y="48" fill="#a3e635" font-family="Inter, sans-serif" font-size="17">Any shell / application</text><text x="41" y="72" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">secrets exec prod -- command</text><text x="41" y="91" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">SDK available to other consumers</text><rect x="650" y="20" width="285" height="105" rx="8" fill="#11191c" stroke="#38bdf8" stroke-width="1.5"/><text x="666" y="48" fill="#38bdf8" font-family="Inter, sans-serif" font-size="17">agents-cli</text><text x="666" y="72" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">small private client + fleet policy</text><text x="666" y="91" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">run / browser / accounts callers</text><rect x="300" y="205" width="350" height="105" rx="8" fill="#11191c" stroke="#a3e635" stroke-width="1.5"/><text x="316" y="233" fill="#a3e635" font-family="Inter, sans-serif" font-size="17">Standalone secrets package</text><text x="316" y="257" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">bundle validation · resolve · exec</text><text x="316" y="276" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">grant broker · stores · audit events</text><rect x="25" y="405" width="270" height="110" rx="8" fill="#11191c" stroke="#a3e635" stroke-width="1.5"/><text x="41" y="433" fill="#a3e635" font-family="Inter, sans-serif" font-size="17">Local adapters</text><text x="41" y="457" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">OS stores · encrypted file · age</text><text x="41" y="476" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">signed helper keeps its identity</text><rect x="355" y="405" width="265" height="110" rx="8" fill="#11191c" stroke="#a3e635" stroke-width="1.5"/><text x="371" y="433" fill="#a3e635" font-family="Inter, sans-serif" font-size="17">Cloud adapters</text><text x="371" y="457" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">1Password store + references</text><text x="371" y="476" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">AWS Secrets Manager selectors</text><rect x="680" y="405" width="255" height="110" rx="8" fill="#11191c" stroke="#38bdf8" stroke-width="1.5"/><text x="696" y="433" fill="#38bdf8" font-family="Inter, sans-serif" font-size="17">Optional SSH transport</text><text x="696" y="457" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">OpenSSH targets, pinned keys</text><text x="696" y="476" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">no device registry / Tailscale</text></svg><figcaption>Proposed: one-way integration; providers and remote execution stay distinct</figcaption></figure>

| Responsibility | Final owner | Concrete extraction |
|---|---|---|
| Bundles, validation, provider resolution, child injection | Standalone secrets | Move `bundles.ts`, `index.ts`, `lease.ts`, `session-store.ts`; split platform storage from reference resolution |
| OS stores, encrypted file, age vault, signed helper | Standalone secrets | Move local adapters and helper download/release inputs; keep current keychain service/access-group identity during cutover |
| Unlock/lock, hold expiry and broker | Standalone secrets | Broker owns its process lifecycle and helper reaping; agents daemon stops hosting it |
| Secret events and local usage | Standalone secrets, value-free event output | Replace imports of feed/analytics with local storage plus an optional event callback; agents consumes events through its client |
| Device aliases, host selection, credential provisioning election | agents-cli | Move `reserved-sync.ts` policy out of the secrets tree; retain one daemon executor |
| Harness/account rules and resource profile selection | agents-cli | Pass allowed bundle names and opaque grant scope into the client; no harness catalog in the package |
| OS-independent remote source / transfer | Optional secrets SSH adapter | Reuse existing transport validation and bounded subprocess primitives, using OpenSSH targets instead of a fleet registry |
| Managed ciphertext sync | Optional sync adapter | Keep `SyncBackend`; provider auth and service URL belong in its configuration, not core defaults |

Existing account/profile tokens are also consumers: `account-registry.ts` calls both raw keychain and bundle APIs, `profiles.ts` uses the raw-token shim, and browser calls resolve bundles directly. The client must cover raw-item operations as well as bundle resolution before the implementation can leave. [cli/src/lib/account-registry.ts:27](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/account-registry.ts#L27) · [cli/src/lib/profiles.ts:16](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/profiles.ts#L16) · [cli/src/lib/browser/chrome.ts:7](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/browser/chrome.ts#L7).

**Packaging choice:** publish a standalone CLI/SDK from a separate repository. agents-cli depends on a small protocol client, not the full SDK or its transitive providers. Provision the executable through the existing external-CLI installer (`cli/src/lib/cli-resources.ts`), extending its manifest/update checks for this supported protocol pair, with an explicit supported protocol range. Verify the packed agents tarball contains no stores, Swift helper, vault crypto or provider SDK. A package dependency that rebundles those files fails the extraction goal.

## Device behavior without device coupling

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide"><svg class="artifact-diagram" viewBox="0 0 960 315" role="img" aria-label="Which machine holds the secret, and which machine runs the child?"><defs><marker id="a315" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8"/></marker></defs><path d="M160 115 L160 190" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a315)"/><text x="167.0" y="144.5" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12"></text><path d="M485 115 L485 190" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a315)"/><text x="492.0" y="144.5" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12"></text><path d="M805 115 L805 190" stroke="#38bdf8" stroke-width="1.6" marker-end="url(#a315)"/><text x="812.0" y="144.5" fill="#91a8b5" font-family="Inter, sans-serif" font-size="12"></text><rect x="25" y="25" width="270" height="90" rx="8" fill="#11191c" stroke="#a3e635" stroke-width="1.5"/><text x="41" y="53" fill="#a3e635" font-family="Inter, sans-serif" font-size="17">Local use</text><text x="41" y="77" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">local provider → local child</text><rect x="350" y="25" width="270" height="90" rx="8" fill="#11191c" stroke="#38bdf8" stroke-width="1.5"/><text x="366" y="53" fill="#38bdf8" font-family="Inter, sans-serif" font-size="17">Remote execution</text><text x="366" y="77" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">SSH → remote secrets → remote child</text><rect x="675" y="25" width="260" height="90" rx="8" fill="#11191c" stroke="#f59e0b" stroke-width="1.5"/><text x="691" y="53" fill="#f59e0b" font-family="Inter, sans-serif" font-size="17">Remote source</text><text x="691" y="77" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">remote secrets → local child</text><rect x="25" y="190" width="270" height="95" rx="8" fill="#11191c" stroke="#a3e635" stroke-width="1.5"/><text x="41" y="218" fill="#a3e635" font-family="Inter, sans-serif" font-size="17">secrets exec prod -- …</text><text x="41" y="242" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">no fleet installation needed</text><rect x="350" y="190" width="270" height="95" rx="8" fill="#11191c" stroke="#38bdf8" stroke-width="1.5"/><text x="366" y="218" fill="#38bdf8" font-family="Inter, sans-serif" font-size="17">agents ssh worker …</text><text x="366" y="242" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">agents owns placement only</text><rect x="675" y="190" width="260" height="95" rx="8" fill="#11191c" stroke="#f59e0b" stroke-width="1.5"/><text x="691" y="218" fill="#f59e0b" font-family="Inter, sans-serif" font-size="17">secrets exec --host …</text><text x="691" y="242" fill="#c8d0d4" font-family="Inter, sans-serif" font-size="13">explicit ephemeral transfer</text></svg><figcaption>Which machine holds the secret, and which machine runs the child?</figcaption></figure>

| Intent | Proposed command | Where values go |
|---|---|---|
| Use a local or cloud-backed bundle | `secrets exec prod -- ./deploy.sh` | Provider → local child environment |
| Run on another machine | `agents ssh worker 'secrets exec prod -- ./deploy.sh'` | Remote provider → remote child; ordinary SSH also works |
| Use secrets held on another machine | `secrets exec prod --host worker -- ./deploy.sh` | Pinned SSH source → private local pipe → local child |
| Store a copy on another machine | `secrets export prod --host worker` | Explicit transfer into destination store; read-back before success |
| Inspect remote metadata | `secrets list --host worker --json` | Names/status only; no resolved values |

`--host` is the standalone endpoint flag. It accepts an OpenSSH alias or `user@host`, with `--port` when needed; it does not look up agents devices. `exec --host` reads from that host and runs the child locally. `list`, `view`, `unlock` and `lock --host` act on that host. `import --host` pulls a bundle into the local selected backend; `export --host` pushes to the remote selected backend. File paths always refer to the invoking machine. Remote execution remains an outer SSH command. Help must show these per-verb examples, and reject ambiguous combinations of a host and file transfer source/destination. The optional transport uses a fixed remote executable and versioned request, never a shell command assembled from bundle values. `--device` stays on agents-owned placement commands. No permanent `agents secrets` management alias is proposed; update scripts, skills and callers at cutover.

Today `secrets exec --device` resolves remotely and then invokes local `spawn`. It rejects remote key-subset and expiry overrides. Separately, remote `agents run` rejects explicit `--secrets`. Preserve these distinctions in migration tests; don't silently reinterpret an existing command. Proposed remote-source resolution carries key selection and expiry policy in the protocol and refuses a peer that cannot enforce them. [cli/src/commands/secrets.ts:2468](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/commands/secrets.ts#L2468) · [cli/src/commands/exec.ts:1717](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/commands/exec.ts#L1717) · [cli/src/lib/hosts/passthrough.ts:165](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/hosts/passthrough.ts#L165).

## A portable bundle format

The format declares **environment names and explicit sources**. It carries no device list, account tokens, machine paths for managed stores, or provider credential. Local connection settings live separately in the secrets config directory, selected with `--config`; the default follows the OS config-directory convention. A supplied `--file` is explicit; do not walk arbitrary parent directories and execute discovered config.

```yaml
version: 1
name: prod
vars:
  API_TOKEN:
    source:
      provider: onepassword
      connection: work
      ref: op://Engineering/Service/credential
  DATABASE_URL:
    source:
      provider: aws-secrets-manager
      secretId: apps/prod/database
      region: us-east-1
      jsonPointer: /url
      versionStage: AWSCURRENT
  LOCAL_SIGNING_KEY:
    source:
      provider: local
      item: prod/signing-key
  LOG_LEVEL:
    literal: info
```

The YAML document is a serialization of a versioned JSON Schema, not a new scripting language. Require exactly one of `source` or `literal` per variable, reject duplicate keys/unknown fields/unsupported versions, and preserve string bytes unless an explicit transform is requested. `literal` means non-secret configuration. Reject missing fields, binary secret values for environment injection, NUL bytes and non-string selected JSON values. Omitted AWS selector means the entire `SecretString`; a JSON pointer requires valid JSON. Neither provider credentials nor secret values belong in this document.

Local OS/file/age choices belong in machine configuration behind `provider: local`. A cloud source remains authoritative: rotating it changes the next resolution, without importing a second copy into a local vault. Mutable cloud references (including AWS AWSCURRENT and unversioned 1Password fields) are freshly fetched for every exec or SDK resolve invocation; only batch/deduplicate within that invocation. Persistent holds apply to local-store grants, not mutable cloud values. Scope local cached values by provider identity, reference/version, requested keys and grant; never extend a cache beyond the grant or temporary credential expiration. Native prompt policy is a local-store capability; don't claim that 1Password or AWS implements Touch ID `hold`/`always` semantics.

<section class="artifact-grid artifact-grid-2">
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>Inspect without reading values · proposed CLI mockup</h3><pre><code>secrets view prod
API_TOKEN        onepassword           reference
DATABASE_URL     aws-secrets-manager   reference
LOCAL_SIGNING_KEY local                 locked
LOG_LEVEL        literal               info</code></pre></section>
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>Validate and run a reference file · proposed CLI mockup</h3><pre><code>secrets check --file prod.secrets.yaml
Valid: 4 variables; no values resolved.
secrets exec --file prod.secrets.yaml -- ./deploy.sh
Deployment finished.
# Illustrative child output, not a live deployment.</code></pre></section>
</section>

## Backends: reuse the tools people already trust

| Option | Actual role | Decision |
|---|---|---|
| Existing OS/file/age adapters | Local value storage | Extract existing code; avoid a crypto rewrite |
| 1Password | Authoritative value storage and live references | Official 1Password SDK: selectable writable store plus live field references; explicit account connections |
| AWS Secrets Manager | Versioned application secrets | Second remote provider: official SDK credential chain, explicit region/selector |
| `aws-vault` | AWS credential/session launcher | Compose around secrets; no fake storage adapter |
| External tools only, no shared package | Simple single-provider workflows | Valid for users needing only `op run`; insufficient for the current mixed stores and embedded consumers |
| Move everything unchanged into an SDK | Changes code location | Reject as final state: daemon/fleet imports and shipped code size would remain |

```sh
# AWS authentication wrapper; application values still come from Secrets Manager.
aws-vault exec engineering -- secrets exec prod -- ./deploy.sh

# A 1Password-only user may already need no additional tool.
op run --env-file=prod.env -- ./deploy.sh
```

Primary documentation checked 2026-09-06: 1Password describes replacing plaintext entries with secret-reference URIs and injecting them through `op run`; service accounts can be vault-scoped. This plan uses stable references, not the separately labelled beta Environments feature. [1Password scripts](https://developer.1password.com/docs/cli/secrets-scripts/).

AWS returns `SecretString` or `SecretBinary`; without a version selector it uses `AWSCURRENT`. The resolver needs `secretsmanager:GetSecretValue`, plus `kms:Decrypt` for a customer-managed key. [AWS GetSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html). `aws-vault` uses STS temporary credentials and can pass them to a subprocess. [aws-vault README](https://github.com/99designs/aws-vault). These are documented capabilities, not authenticated provider smoke tests performed in this session.

<details><summary>Live documentation captures and inspection notes</summary>
<figure class="artifact-figure"><img src="op-docs.jpg" alt="1Password developer documentation showing secret references and script injection"/><figcaption>1Password scripts page, browser capture inspected 2026-09-06. The page lists op run, op read and vault-scoped service accounts.</figcaption></figure>
<figure class="artifact-figure"><img src="aws-docs.jpg" alt="AWS GetSecretValue documentation showing SecretString and SecretBinary"/><figcaption>AWS GetSecretValue page, browser capture inspected 2026-09-06. Cookie panel remains visible; the API behavior text is readable. No authenticated secret was read.</figcaption></figure>
</details>

## Choose where secrets actually live

**Yes: agents-cli can use Secrets CLI, and Secrets CLI can use 1Password as its backend. In that configuration the application values live in 1Password.** agents-cli is a consumer, not another storage backend. Selecting 1Password never silently copies application values into macOS Keychain or the local encrypted store. Choosing a local backend keeps values there. Explicit import/export is how a user copies them.

Today `import1password` extracts fields and calls `applyEnvToBundle`, making a local copy. That import path does not make 1Password authoritative. The new adapter provides both writable bundle storage and direct references to existing external fields. [Current import path, secrets.ts:2261](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/commands/secrets.ts#L2261).

| Selection | Authoritative application values | Local state |
|---|---|---|
| `--backend keychain` on macOS | Existing Keychain items | Metadata, grants and existing native session cache |
| `--backend libsecret` on Linux | Secret Service collection | Metadata; collection authentication belongs to the OS |
| `--backend file` or `vault` | Existing encrypted file/age store | Encrypted values and existing key material |
| `--backend onepassword --connection work` | Selected 1Password account and vault | Non-secret connection settings and item IDs; no persistent copy of resolved application values |
| A mixed reference manifest | Each variable's declared provider | Manifest references; invocation-local resolved values only |

Backend names in this table are the proposed explicit CLI vocabulary; migrate the legacy `keychain` platform abstraction carefully. A saved backend/connection default is allowed; an explicit flag wins. Store selection controls named-bundle CRUD, while each manifest source controls its own resolution. Never reinterpret an explicit AWS or 1Password reference as a local item because a default changed.

```sh
secrets create prod --backend onepassword --connection work
secrets exec prod --backend onepassword --connection work -- ./deploy.sh
secrets view prod --backend onepassword --connection personal
```

Use the official JavaScript SDK behind the adapter; pin its version and test the supported macOS/Linux distributions. A local connection alias such as `work` selects a specific account UUID and vault ID, with desktop or service-account authentication. `personal` is a different client identity. Reject ambiguous account/vault names; never choose the most recently signed-in account. The existing `op` CLI does have ambient account-selection behavior, so any deliberately supported CLI transport must pass its account explicitly. [SDK setup](https://www.1password.dev/sdks) · [CLI account selection](https://www.1password.dev/cli/use-multiple-accounts).

For bundles created by Secrets CLI, use one dedicated item with concealed value fields and a versioned descriptor mapping environment names to field IDs. Persist returned vault/item/field IDs; do not identify writable items by title alone. Read/update/delete only the explicitly mapped owned item, preserve unknown fields, and fail on unsupported item shapes. Existing third-party items are referenced without ownership or mutation rights. SDK item management supports creation and updates using IDs. Test concurrent updates and conflicts before enabling writes. [SDK item management](https://www.1password.dev/sdks/manage-items).

Desktop authentication may prompt and grants access to the authorized account; service accounts offer vault-scoped automation and cannot access built-in Personal/Private/Employee vaults. Their read/write permissions must match the requested operation. Headless calls must fail before any prompt when authorization is absent; the SDK integration must prove this behavior before release. Do not silently swap identities. [SDK authentication](https://www.1password.dev/sdks/concepts).

## Import and export are first-class

Keep both directions on macOS and Linux. A portable **manifest** transfers references only; a **backup** carries actual selected values plus metadata inside the existing authenticated encrypted envelope. These are distinct versioned formats. Default export is an encrypted backup and requires an explicit backup-passphrase source; never silently use a machine-only key for a portable backup. `--format manifest` exports the reference document without resolving values. Import auto-detects only supported versioned formats, validates the entire input, and reports conflicts before writes; overwrite requires `--replace`.

```sh
# Existing encrypted envelope; backup passphrase arrives on private stdin.
secrets export prod --output prod.secrets.enc --passphrase-stdin
secrets import --file prod.secrets.enc --passphrase-stdin \
  --backend onepassword --connection work

# Portable references, with no secret values.
secrets export prod --format manifest --output prod.secrets.yaml
secrets import --file prod.secrets.yaml

# Host transfers stream privately; no plaintext staging files.
secrets import prod --host worker --backend keychain
secrets export prod --host worker --backend file
```

For host transfer, `import` selects the destination backend locally and uses the remote configured source; `export` selects the destination backend remotely and uses the local configured source. A named source requiring a different connection is expressed through its saved configuration; do not overload one flag with two endpoint meanings. Reference-only import registers bindings and never materializes them. An encrypted backup resolves values only after explicit export authorization, including referenced values, then writes them to the selected import backend. Provider bootstrap tokens and live unlock grants are never exported. Reuse the existing AES-GCM passphrase envelope and its KDF/version contract; no public-recipient age format is introduced by this plan. Export/import obtain the backup passphrase from private stdin via `--passphrase-stdin`, or a deliberate interactive prompt. Headless calls without a supplied passphrase fail. This portable backup password is independent of normal password-free local setup. File output uses exclusive creation and mode 0600; diagnostics contain no values. Restore preserves byte strings, multiline values, names and policies that the destination can enforce; unsupported policy fails before mutation.

Local writes use atomic replacement. A cloud provider may not offer cross-item transactions: preflight, create/update a single mapped bundle item, read back, and return a value-free receipt. Multi-bundle import records per-bundle outcomes and is resumable; never claim all-or-nothing rollback across a vendor API. Failed imports retain their source. Export with `--all` includes hidden bundles and says so in metadata. Plaintext env import from stdin remains supported for existing workflows; plaintext export is explicitly materializing and follows the reveal/context guard, never the default.

## Unlock once, and keep the behavior people use

```sh
secrets unlock prod
secrets unlock prod --durable
secrets unlock prod --ttl 7d
secrets lock prod
secrets status prod --json
```

**No new mandatory master password or keychain-password flag.** macOS uses existing OS authorization. The current encrypted file store auto-generates machine key material unless an optional passphrase is supplied; preserve that behavior. An OS/provider may still require its own login when locked. [filestore.ts:134](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/filestore.ts#L134).

| Backend / platform | `unlock` | `unlock --durable` | What ends access |
|---|---|---|---|
| macOS local grant-backed storage | Deliberate authorization; preserve default 7-day TTL; survives process restart/upgrade | Preserve access across sleep/reboot using existing native persisted grant/session mechanism | Expiry or explicit lock; normal grants also clear on sleep |
| Linux persistent local storage | Validate store/key readiness; no new Secrets CLI password or artificial unlock session | Accepted with explicit status that persistence already applies | OS collection lock or loss of key access; Secrets CLI lock has no synthetic TTL grant to revoke |
| 1Password desktop auth, either OS | Request vendor authorization only in deliberate interactive flow | Unsupported durability capability; do not extend vendor session or copy values locally | Vendor lock or authorization expiry |
| 1Password service account / AWS | Validate configured noninteractive credentials and requested access | No local durability grant; unsupported capability | Vendor credential/session expiry or revocation |

Linux preserves the current persistent-store model rather than inventing a second password/session layer. `status --json` reports capabilities (`grantExpiry`, `durableUnlock`, `lock`) and the actual state. A Linux `lock` request must report that no Secrets CLI grant exists and provide the applicable OS/key action; it must not falsely claim the store is locked. Remote `unlock --host` cannot relay a GUI authorization sheet; unsupported native-headless requests fail with a concrete host-side instruction.

The current command defaults unlock TTL to 7 days and makes non-macOS unlock/durability a no-op. Improve that no-op into an honest readiness check. macOS persists resolved local values in a no-ACL Keychain session item; this is an existing trusted-user tradeoff being preserved, not a memory-only promise. Normal grants survive screen lock and restart but clear on sleep; durable grants survive sleep/reboot until expiry. [unlock command:2691](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/commands/secrets.ts#L2691) · [Linux branch:2758](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/commands/secrets.ts#L2758) · [session-store.ts:1](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/session-store.ts#L1).

1Password desktop authorization expires after 10 minutes of inactivity or account lock. A local durable grant cannot override that. Keep cloud values fresh per invocation and preserve ordinary vendor authentication lifetimes. [1Password authorization lifetime](https://www.1password.dev/sdks/concepts).

## Hidden bundles remain directly addressable

<figure class="artifact-figure artifact-behavior">
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>Default discovery · proposed CLI mockup</h3><pre><code>secrets list
prod
staging
# __rand_bundle_name__ is omitted.</code></pre></section>
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>Exact lookup · proposed CLI mockup</h3><pre><code>secrets view __rand_bundle_name__
API_TOKEN  onepassword  reference
# Metadata is visible; values remain protected.</code></pre></section>
</figure>

Recognize the exact `__name__` wrapper. Extend the canonical grammar to accept a nonempty ordinary inner name, with a total maximum length of 49 characters including delimiters. Keep ordinary names unchanged; reject paths, slashes and empty wrapped names. The current leading-alphanumeric regex rejects the requested example, so update shared validation, metadata parsing and file/vault enumeration together. [bundles.ts:198](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/bundles.ts#L198).

Default `list`, `list --json`, completion and pickers omit wrapped names. `list --all` includes them. Exact `view`, `exec`, `unlock`, `lock`, import/export and raw SDK lookup resolve them normally, with the same authorization rules. Internal inventory, backup, migration, expiry/reaping and `lock --all` always include hidden bundles. Hiding is presentation, never permission; do not feed the discovery filter into revocation or migration.

## A release script, including notarization

The new `phnx-labs/secrets-cli` repository owns canonical `scripts/build.sh`, `test.sh`, `install.sh` and **`scripts/release.sh <version> [--apply]`**. Release promotes the tested package, verifies registry visibility, performs a clean-prefix install, checks protocol compatibility, and runs installed macOS/Linux canary flows. Keep auto-update and immutable versioned helper manifests. Dry-run is the default.

The native path is a separate `scripts/release-keychain-helper.sh <version> [--apply]`: build the macOS architectures, sign with the existing identity and entitlements, submit using `notarytool`, require Accepted, staple the distributed app, validate the staple and signature, then upload the immutable archive plus checksum manifest. Keep Team ID, access groups, bundle/service identifiers and existing-item access intact during adoption; product naming does not authorize changing native storage identity.

| Train | Build and publication | Required installed proof |
|---|---|---|
| Ordinary Secrets CLI release | CLI package only; reuse signed/notarized native helper artifact | Fresh install obtains verified helper; can unlock and inject into child |
| macOS helper release | Sign → notarize → staple → immutable helper tag/manifest | Download published archive on a clean macOS account; verify signature, expected identity, staple and Gatekeeper assessment; read an adopted canary item |
| Linux release | CLI and required Linux runtime dependencies; no Apple tooling | Native Secret Service and explicit encrypted-file canaries on supported architectures |
| agents integration release | Small client only; supported Secrets CLI protocol pair | Existing consumer flows use separately installed Secrets CLI |

Existing signing/notarization mechanics are in `build-keychain-helper.sh`, while its staple/assessment failures are currently softened to messages. The new release gate must enforce success for the distributed app artifact, not copy those permissive checks. Hash verification alone is not notarization verification. All required release proof has an automated producer in the same change. Preserve the repository's ordinary-release and CI latency constraints; signing/notarization belongs to the helper's independent train. [Existing signing pipeline:118](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/scripts/build-keychain-helper.sh#L118) · [Current helper hash verifier:1](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/scripts/verify-keychain-helper.sh#L1).

## Proposed Changes

The ordered implementation work is in [tasks.md](tasks.md); it is a future build checklist, not completed work. The proposed contract is in [delta-spec.md](delta-spec.md). Extract in dependency order and make the deletion a release criterion.

| Step | Concrete delta | Exit evidence |
|---|---|---|
| 1. Define the boundary | Schema, client protocol, import/caller inventory; lifecycle decisions | Real fixture bundle validated; consumer mapping signed off |
| 2. Extract local engine | Existing stores, grants, helper and CLI into independent repo | Clean-prefix install can run an injected child without agents installed |
| 3. Add live references | 1Password writable backend + field references; Secrets Manager reads; capability errors and auth stripping | Read disposable known-value secrets through real services; print only match verdicts |
| 4. Extract transport | OpenSSH adapter plus private remote protocol | Different source/child hosts, selected keys, denied/unreachable peer all exercised |
| 5. Convert agents consumers | Small client; account/fleet policy retained; remove daemon broker hosting | Installed run, browser secret entry, accounts and raw-token paths work |
| 6. Cut over and delete | Explicit inventory-based store adoption/import, scripts and docs switch, old engine removed | Packed agents artifact proves deletion; one broker owns grants |
| 7. Release and demonstrate | Independent publishing/update; supported pair installed | Fresh standalone and updated agents both exercise real local and remote flows |

Native helpers release on their own cadence. Ordinary Secrets CLI and agents releases must reuse the approved signed/notarized keychain helper. Existing CI/release latency ceilings remain acceptance constraints; measure the new package's path independently rather than adding its service matrix to the agents PR gate.

## Public Interface

**Stable standalone CLI:** metadata commands (`list`, `view`, `check`, `status`, `activity`) support `--json`; `exec` owns a child with inherited output and the child's exit/signal outcome. `exec` does not emit a metadata JSON header into child stdout. All metadata stays value-free. Mutation supports stdin for values; no secret argument literals in examples or automation. Local-store management, native migration and encrypted sync remain in their owning adapters, not duplicated in agents.

**SDK:** `createSecrets(config).resolve(request)` is asynchronous and returns an environment map in application memory. Store mutation is a separate capability; a read-only cloud provider does not pretend it can rotate/delete secrets. Resolve all selected keys before spawning; a partial failure starts no child. The SDK is optional for third-party apps; agents uses the small process client to keep the engine out of its tarball.

**Private integration:** a bounded, versioned request/response channel over inherited pipes, with request id, operation, bundle, key selection, expiry override, interaction mode and opaque scope. Operations cover metadata, bundle resolution, raw-item CRUD and grant lifecycle. Reply includes resolved strings only on the private channel, or typed value-free errors. Child stdout remains separate. Reject protocol mismatch before resolving anything. No new network daemon, plugin marketplace or general RPC framework.

**Materialization guard:** standalone detects `SECRETS_CONTEXT=agent` plus the existing agent invocation markers through a small context detector (no agents import). The agents client sets that signal. Bundle `view --reveal` refuses under those markers or without an interactive terminal; preserve the current narrow raw-item exception. The signal prevents accidental disclosure through supported tools, not a malicious same-user process.

**Policy seam:** caller supplies bundle allowlist and opaque scope. agents maps harness/account/resource-profile rules to those inputs. Secrets core enforces validation, grant/key/expiry limits and headless behavior independently. Standalone automation defaults to non-interactive; a deliberate terminal unlock can request an interactive provider operation. Preserve existing native-headless no-prompt guarantees. [cli/src/lib/secrets/bundles.ts:983](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/bundles.ts#L983) · [cli/src/lib/secrets/scope.ts:1](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/scope.ts#L1).

<section class="artifact-grid artifact-grid-2">
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>Locked / unauthenticated provider · proposed CLI mockup</h3><pre><code>secrets exec prod -- ./deploy.sh
AUTH_REQUIRED: onepassword is not authenticated.
Authenticate with 1Password, then retry.
Command was not started.</code></pre></section>
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>Peer cannot enforce the request · proposed CLI mockup</h3><pre><code>secrets exec prod --host worker --keys API_TOKEN -- ./deploy.sh
PROTOCOL_UNSUPPORTED: peer cannot enforce key selection.
Update secrets on worker, then retry.
Command was not started.</code></pre></section>
</section>

<section class="artifact-grid artifact-grid-2">
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>Empty store · proposed CLI mockup</h3><pre><code>secrets list
No bundles configured.
Use secrets create &lt;name&gt; or secrets check --file &lt;path&gt;.</code></pre></section>
<section class="artifact-panel" data-state="proposed" data-evidence="mockup"><h3>Operation not supported by provider · proposed CLI mockup</h3><pre><code>secrets rotate prod DATABASE_URL
CAPABILITY_UNSUPPORTED: aws-secrets-manager is read-only here.
Change the secret in AWS; next execution reads the new version.</code></pre></section>
</section>

## Plan

- [ ] Define schema and private client protocol.
- [ ] Extract existing local stores, broker and native helper.
- [ ] Add selectable 1Password storage, multiple accounts and live AWS references.
- [ ] Preserve unlock/durable behavior; add hidden-name semantics and import/export.
- [ ] Extract OpenSSH transport with explicit source/destination semantics.
- [ ] Convert every agents consumer and preserve policy.
- [ ] Verify encrypted store cutover, then remove the old engine.
- [ ] Publish through scripts/release.sh; verify notarization and demonstrate the installed pair.

These boxes are future implementation. The file-by-file tasks are linked above; this session delivers the reviewed plan.

## Validation

| Real scenario | Required observation |
|---|---|
| Standalone install, agents absent | Local encrypted-store injection and metadata work; no import or spawn of agents |
| macOS human unlock then headless reads | One deliberate prompt; subsequent granted reads work, expired grants fail without a sheet |
| macOS/Linux local stores | Actual native or declared encrypted store works; no silent change of selected backend |
| 1Password / AWS | Two 1Password accounts with colliding item titles remain isolated; create/update/import/export a disposable owned item; missing auth, denied writes, rotation and expiry exercised; AWS read-only failures remain explicit |
| Import/export | macOS↔Linux encrypted round trip, exact multiline bytes, wrong backup passphrase, duplicate conflicts, failed partial cloud restore and hidden bundle inclusion |
| Unlock and hidden names | Normal macOS sleep revokes, durable survives sleep/reboot until TTL; Linux readiness is honest; hidden exact lookup works while discovery omits it; lock --all still revokes hidden grants |
| Release | Published CLI install and downloaded helper signature, notarization/staple and actual adopted-item access succeed; no helper rebuild on ordinary release |
| Remote source versus remote execution | Child prints hostname and a boolean equality check, never values; source and execution location match requested flow |
| Failure before spawn | Missing key, rejected selector, timeout, expired lease, broken pipe: no child side effect |
| Injection hygiene | Launcher never logs/argv-embeds values; strips unlock/provider credentials unless explicitly selected for child; loader env remains filtered |
| Reveal and remote-input guards | Real standalone reveal refuses with agent markers and no TTY; raw-item exception remains explicit. Remote GIT_SSH_COMMAND, HTTPS_PROXY, OPENAI_BASE_URL and loader keys are rejected before child spawn. |
| Multi-bundle run | Preserve profile → account → auto-share → bundles in order → explicit --env precedence; validate all selected bundles before launch (`commands/exec.ts:3244`) |
| Existing consumers | Real run, browser field fill, account add/read/rotate, SSH-password lookup, share config and profile token access |
| Packaging + lifecycle | No old engine in agents tarball, no duplicate broker after update/restart, independent helper update works |

Use non-sensitive canaries and real OS/providers. Test files sit beside their sources with nearby `testdata/`. Required PR checks cover the impacted modules; slow provider/platform matrix runs separately. The plan itself is checked/rendered and visually inspected; none of the proposed runtime tests are claimed as executed.

## Risks

| Source / edge | Required treatment |
|---|---|
| Keychain identity and helper signing — [cli/src/lib/secrets/index.ts:47](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/index.ts#L47) | Keep service prefixes, HMAC mapping, signing/access-group entitlements and helper identity stable while moving code. Renaming the product must not strand existing items. |
| Broker auto-boot and self-invocation — [cli/src/lib/secrets/agent.ts:1236](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/agent.ts#L1236); [cli/src/index.ts:28](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/index.ts#L28) | Replace self-exec paths and remove agents hosting in the same cutover. Preserve protocol/identity during transfer; one owner claims the socket. |
| Reserved auth and publisher election — [cli/src/lib/secrets/reserved-sync.ts:12](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/reserved-sync.ts#L12) | Keep fleet election and device-role policy in agents; pass item operations to the client. No headed-device fallback to worker credentials. |
| Provider credential bootstrap | 1Password service tokens / AWS auth must come from native login, environment or standard credential chain, not a bundle that requires itself. Detect resolution cycles and strip bootstrap credentials before child spawn. |
| Policy loss in transport — [cli/src/lib/secrets/remote.ts:44](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/remote.ts#L44) | Retain pinned-host requirement, no multiplexed secret transport, strict key validation and deadlines. Preserve the remote-only rejection of GIT_*, *_PROXY and *_BASE_URL as well as loader/interpreter keys. No widening to full bundle on a subset error. |
| Plaintext surfaces — [cli/src/lib/secrets/mcp.ts:187](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/mcp.ts#L187) | MCP currently returns the value in a tool result; do not describe it as model-invisible. Retain only as explicitly materializing optional adapter, never automatic model wiring. |
| Child can print its environment | Injection prevents the launcher printing secrets; it cannot stop an authorized child or same-user process from disclosing them. No zero-knowledge claim. |
| Local paths and metadata caches — [cli/src/lib/secrets/bundles.ts:124](https://github.com/phnx-labs/agents-cli/blob/f33fdfc456042a3812e87f1a3c5053156d2873c4/cli/src/lib/secrets/bundles.ts#L124) | Explicit backend selection replaces location guessing for new manifests. Migration inventories old state and maps each item once; never silently fall back on authentication failure. |

**Cutover protocol:** dry-run inventories bundles, raw profile/account items, policies, metadata and grants without values. For native keychain, adopt identifiers in place. For file/age stores, either select the existing encrypted location explicitly or perform an atomic encrypted import with read-back. Record a value-free migration receipt, invalidate or deliberately transfer scoped grants, then switch consumers. Keep the prior encrypted source until verification succeeds; do not dual-write or delete old credentials automatically. Rollback restores the previous installed pair and original store configuration; after a migrated store receives new writes, rollback requires an explicit reconciliation, not blind restoration of stale data.

## Independent verification

A blind planner independently read source without seeing this proposal. It agreed on independent packaging, three separate interfaces (source/store/ciphertext sync), explicit YAML/JSON bindings, provider-native references, remote-source versus remote-execution semantics, and one broker owner. This is a same-provider second opinion: cross-provider fleet launches failed, and a separately verified Claude invocation reached its timeout without a plan. No cross-provider consensus is claimed.

| Finding | Disposition | Evidence / resulting decision |
|---|---|---|
| Independent planner: 1Password import is lossy | ADOPTED | `onepassword.ts:190–201` chooses one field and skips multiline values. Live field refs replace import as the default cloud flow; byte-preserving real tests are required. |
| Independent planner: preserve full run precedence | ADOPTED | `commands/exec.ts:3244` merges profile → account → auto-share → bundles → explicit `--env`. Keep that agents-owned precedence; a general secrets SDK cannot infer it. |
| Independent planner: temporary management alias | REJECTED as final design | User requested full extraction and no compatibility layer. Update callers at cutover; do not keep a permanent `agents secrets` command. Existing encrypted/native data is protected separately. |
| Non-author reviewer: reveal guard and remote filters missing | FIXED + APPROVED | Restore context/TTY reveal refusal and remote GIT/proxy/base-URL restrictions, with concrete CLI tests. |
| Non-author reviewer: cache versus rotation contradiction | FIXED + APPROVED | Mutable cloud refs resolve fresh every invocation; holds remain local-store grant behavior. |

The non-author reviewer also checked the owner refinements: explicit accounts/writable 1Password, --host, hidden names, unlock and notarized releases. Its one backup-format finding was fixed by retaining the existing AES-GCM passphrase envelope with explicit passphrase input, rather than introducing an undocumented age-recipient format. The reviewer approved the corrected documentation contract. This verifies the plan's consistency and source grounding; it is not evidence that the proposed implementation already works.

## Tracking

- [Documentation PR #3499](https://github.com/phnx-labs/agi-cli/pull/3499).

- [PHNX-3989: this planning deliverable](https://linear.app/getrush/issue/PHNX-3989). Close with the rendered plan and review proof; runtime extraction is still proposed.
- [PHNX-3975: related configuration work](https://linear.app/getrush/issue/PHNX-3975). Coordination reference only; this plan does not change or take over that proposal.
- [Implementation tasks](tasks.md) · [Proposed delta contract](delta-spec.md) · [Raw inventory](inventory.json).

## Evidence appendix

Code evidence is pinned to `f33fdfc456042a3812e87f1a3c5053156d2873c4` from a freshly fetched origin on 2026-09-06. `inventory.json` lists each counted path and line total. Counting uses `splitlines()` on non-test TypeScript under `cli/src/lib/secrets/` and `cli/src/commands/secrets*.ts`; it excludes `__tests__`. Consumer scanning records direct static/dynamic imports, including benchmarks/fixtures labelled by path; it is an integration starting list, not a transitive dependency count. Shell scripts, native helper releases, resource definitions and docs must also be searched at cutover. No runtime throughput, size reduction or implementation-duration claim is inferred from line counts.
