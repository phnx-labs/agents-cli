# Delta spec — the contract after account model v2

Source of truth a later change diffs against. Requirement ids ACC-*.

- ACC-1 Exactly one managed installation per harness per device (label `main`); `agents update <h>` moves only its release.
- ACC-2 An account is a fleet-shared row {id, harness, name unique per harness, identityKey, identityLabel, provisioning, workerCredential?}; it never carries a secret value.
- ACC-3 A slot is the per-device materialization of an account: a HOME-shaped dir with no binary, selected at spawn through the harness config-dir pin; symlink-adopted harnesses hold one active slot per device.
- ACC-4 `agents accounts add <h> [name]` runs only on a headed device; it logs in natively into the new slot, registers the row, mints or collects the worker credential, and requests one daemon reconcile. On a worker it fails with the role hint.
- ACC-5 A worker slot is created by the daemon from the row plus the durable credential; a native OAuth or session file never leaves its device (SING-1b unchanged).
- ACC-6 Every listing renders the daemon verdict (live | expired | revoked | rate_limited | missing | unverified | per-device) and the exact fix; the daemon posts an owner-important feed message on live→expired|revoked.
- ACC-7 Rotation candidates are slots with verdict in {live, unverified}; a `missing` or `expired` slot is never launched.
- ACC-8 Migration moves homes, never copies credentials; removed homes go to trash; `agents trash restore` reverses.


<figure class="artifact-figure artifact-behavior">
  <section data-state="current" data-evidence="capture">
    <h4>Current — <code>agents accounts list</code> (owner capture, redacted)</h4>
    <pre><code>Native logins     run &lt;harness&gt;#&lt;label&gt;
  claude       personal    * m***@gmail.com        connected
               dev           d***@getrush.ai        connected
               work          m***@getrush.ai        connected
               icloud        m***@icloud.com        connected
  codex        gmail       * m***@gmail.com        connected
               codex-icloud  m***@icloud.com        connected
               codex-smores  t***@…                 connected
  grok         personal      z***@gmail.com         connected
               —           * m***@icloud.com        connected
  opencode     —           * opencode:providers=…   not connected here

Provider bundles  run &lt;harness&gt; --account &lt;name&gt;
  claude-dev-getrush             anthropic   setup-token  ready
  claude-dev-getrush          anthropic   setup-token  ready
  …</code></pre>
    <p>"connected" = a credential file exists. No expiry, no device coverage, no fix. Provider bundles are a second list the user has to join by eye.</p>
  </section>
  <section data-state="proposed" data-evidence="mockup">
    <h4>Proposed — <code>agents accounts list</code></h4>
    <pre><code>Accounts  (run: agents run &lt;harness&gt;#&lt;name&gt;)

  claude   2.1.263 · auto-update
    * personal  m***@gmail.com     LIVE         laptop + 9 workers   Max  W ▍░░░░ 20%
      work      m***@getrush.ai    EXPIRED 2h   laptop + 9 workers   fix: agents accounts login claude#work
      dev       d***@getrush.ai    LIVE         laptop + 9 workers   Max  W █▎░░░ 26%
      icloud    m***@icloud.com    LIVE         laptop + 6 workers   3 missing → syncing

  codex    0.153.4 · auto-update
    * gmail     m***@gmail.com     LIVE         laptop + 9 workers   Pro  W ███░░ 59%
      icloud    m***@icloud.com    RATE-LIMITED laptop + 9 workers   resets in 17h
      smores    t***@…             LIVE         laptop + 9 workers   Team W █▎░░░ 26%

  kimi     0.41.0 · per-device login
    * (this box) kimi:user=d483…   LIVE         laptop, worker-1     fix elsewhere: agents fleet login kimi

  1 account needs you · add another: agents accounts add &lt;harness&gt; [name]</code></pre>
    <p>One row per account per harness. STATE is the daemon verdict; WHERE counts devices with a live slot; FIX is the exact command. Provider bundles disappear as a separate list because the worker credential is a field of the account.</p>
  </section>
</figure>

### Commands after the change

| Verb | Behavior | Today's equivalent |
|---|---|---|
| `agents add <harness>` | Install the one managed installation (`main`) if absent; no login. `@<release>` pins it (expert). | `add` bare-reuse rule `versions.ts:94-106`; `@version` creates a second home |
| `agents accounts add <harness> [name] [--api-key <k>] [--no-worker-token]` | Headed only. Login in a new slot → register row → mint/collect worker credential → daemon sync. Idempotent on an already-registered identity (points at `login`). | `accounts connect` + `accounts mint` + `accounts add --provider` + `accounts sync` |
| `agents accounts login <harness>#<name>` | Re-auth into the same slot on a headed device; re-mints and re-syncs. On a per-device harness, logs this box in. | `connect` reconnect path + `mint` |
| `agents accounts list [<harness>] [--fleet] [--json]` | Verdict + devices + fix per account. `--fleet` is the matrix from the audit's Design C. | `accounts list`, `agents view`, `devices accounts` |
| `agents accounts default <harness> [name]` | Set the fleet-wide default (picker with no name). | `set-default`, `switch` |
| `agents accounts rename <harness>#<old> <new>` | PHNX-3988 semantics. | same |
| `agents accounts remove <harness>#<name>` | Row + bundle + every device's slot → trash. | `remove` (record only) |
| `agents accounts logout <harness>[#<name>]` | This device's slot only. | `logout` |
| `agents accounts sync [<harness>#<name>] [--device <d>]` | Manual reconcile (the daemon does it anyway). | `accounts sync <bundle> <device>` |
| hidden: `connect`, `name`, `label`, `mint`, `attach`, `detach`, `view --versions`, `add <h>@<v>` as a second install, `update <h>@<label>` | Print a one-line pointer to the replacement; removed in the following release. | — |

`agents run <harness>#<name>` is unchanged and becomes the taught selector everywhere (help, README, fleet skills). `--account <name>` stays as the flag form.

### JSON

`agents accounts list --json` emits `{ version: 2, accounts: [{ id, harness, name, identityLabel, isDefault, provisioning, verdict, checkedAt, devices: [{ device, authMode, verdict }], usage, fix }] }`. `agents view --json` keeps `versions[]` (hidden surface) and gains the same `accounts[]` projection; consumers (AGI EXT) read `accounts[]`.

