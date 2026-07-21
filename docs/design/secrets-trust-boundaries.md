# Secrets: trust boundaries & what the agent sees (design)

> Status: **accepted** · Related: [secrets.md](../../apps/cli/docs/secrets.md) (reference),
> [08-secrets-agent-process-model.md](../../apps/cli/docs/08-secrets-agent-process-model.md) (broker process model)

A design record for the **one question every operator eventually asks**: when an
AI coding agent runs a release (or any task) with `agents secrets`, *does the agent
ever see the plaintext key?* The answer is "only if a command materializes it" —
and this doc pins down exactly which commands do, why, and where the boundary is
enforced. It complements the reference doc's [Security model](../../apps/cli/docs/secrets.md#security-model)
(which covers the *keychain ACL* threat model) by tracing the **plaintext data-flow**
past a second boundary the ACL section doesn't name: the agent's own context and
its session transcript.

## The two boundaries

`agents secrets` defends against **on-disk plaintext** (`.env` files, shell history,
accidental commits). That is the reference doc's threat model. This doc adds the
boundary that matters when the *reader* is an agent, not a human:

1. **Storage boundary** — values live in the OS keychain, never on disk as plaintext.
   Reads are gated (Touch ID / passcode). *Covered by the reference doc.*
2. **Materialization boundary** — the line between a secret staying inside a child
   process's environment (invisible to the agent) versus being **printed to stdout**,
   where it lands in the agent's context window *and* is persisted to the session
   transcript (`.jsonl`). *This doc.*

The design intent is: **inject into the child process, never into the agent.** Every
command is on one side of boundary #2 by construction — there is no "sometimes."

## Where values live (storage boundary)

A secret value never exists as a file. On macOS every write goes through the signed
`Agents CLI.app` helper, which attaches an access control of
`[.biometryCurrentSet, .or, .devicePasscode]` via `SecAccessControlCreateWithFlags`
(`src/lib/secrets/keychain-helper.swift:33-45`) — the OS itself gates decryption with
Touch ID / passcode. Bundle *metadata* (names, var list, policy) is itself a keychain
JSON blob — nothing about a secret is on disk.

A **bundle** (`SecretsBundle`, `src/lib/secrets/bundles.ts:186`) maps env-var names
to typed refs (`REF_PATTERN`, `src/lib/secrets/index.ts:51`):

| Ref kind | Where the value is | Reachable by the agent's stdout? |
|---|---|---|
| `keychain:<key>` | keychain item, biometry-gated | only via a materializing command (below) |
| `literal` (`--value`) | inline in metadata JSON — **non-sensitive by contract** | yes (it's not a secret) |
| `env:<VAR>` | parent `process.env` at run time | only if materialized |
| `file:<path>` | a file, read at run time | only if materialized |
| `exec:<cmd>` | stdout of a command, run at resolve time (needs `allow_exec`) | only if materialized |

## The two data-flow paths

### Path A — injection (the agent never sees the value)

This is the release path. `agents secrets exec <bundle> -- <cmd>` and
`agents run --secrets <bundle>` resolve the bundle in memory and hand it to the child
as **environment**, not output. The env is built by `buildSecretsExecEnv`
(`src/lib/secrets/exec` → `src/commands/secrets.ts:353-360`):

```ts
export function buildSecretsExecEnv(parentEnv, secretEnv) {
  const env = { ...sanitizeProcessEnv(parentEnv), ...secretEnv };
  delete env.AGENTS_SECRETS_PASSPHRASE;   // the master key must not reach the child
  return env;
}
```

The resolved values go straight into the spawned process's `env`. They are **never
written to stdout**, so they never enter the agent's context or the transcript. The
agent sees only whatever the *child* chooses to print (`npm publish` → `+ pkg@1.2.3`).

```
  keychain ──(one Touch ID / broker)──▶ resolve in memory ──▶ child process env
                                                                    │
                                              agent sees: child's stdout only
                                              agent does NOT see: the values
```

`buildSecretsExecEnv` also **strips `AGENTS_SECRETS_PASSPHRASE`** — the file-store
master key is used to decrypt, then removed before the child (and thus the agent)
runs, so the one key that unlocks everything never reaches the executed command.

### Path B — materialization (the value is printed → agent + transcript)

Three commands exist to put plaintext *on stdout* on purpose:

- `agents secrets export <bundle> --plaintext` — prints `KEY=VALUE` lines (for
  `eval "$(...)"`).
- `agents secrets view <bundle> --reveal` — unmasks values (`--plaintext` also
  required in a non-interactive shell).
- `agents secrets get <bundle> <KEY>` — prints one value (`src/commands/secrets.ts:1058`).

When an agent runs any of these, the plaintext is in its Bash tool output — which
means it is in the model's context **and** written verbatim to the session `.jsonl`.
That is the moment a key crosses boundary #2. These commands are legitimate (a human
at a TTY evaluating a bundle), but for an *agent* they are the ones to avoid.

## Seen-vs-not-seen, by command

| Command | Plaintext destination | Agent sees it? | In transcript? |
|---|---|:--:|:--:|
| `agents secrets exec <b> -- <cmd>` | child process env | **No** | **No** |
| `agents run --secrets <b>` | agent run's env | **No** | **No** |
| `agents secrets list` / `view <b>` | masked (`••••`) | No (masked) | No |
| `agents secrets export <b> --plaintext` | **stdout** | **Yes** | **Yes** |
| `agents secrets view <b> --reveal` | **stdout** | **Yes** | **Yes** |
| `agents secrets get <b> <KEY>` | **stdout** | **Yes** | **Yes** |

**Rule of thumb for agent-driven flows:** use `exec` / `--secrets`. If you see
`--plaintext`, `--reveal`, or `get` in an agent's transcript, a key entered its
context there.

## The transcript corollary

Because Path B output is persisted to the session `.jsonl`, a materialized secret is
not ephemeral — it is durable in the transcript until that file is deleted. This is
why the operating rules treat transcripts as confidential (secret-gist attachment on
private repos; **never** pasted into a public repo, PR, or tracker). A key that only
ever traveled Path A leaves no transcript residue; a key that traveled Path B does.
The materialization boundary and the "transcripts are confidential" rule are the same
boundary seen from two sides.

## How the boundary is enforced (not just documented)

- **Headless no-prompt.** In a non-interactive/agent context, resolution takes the
  `agentOnly` / `isHeadlessSecretsContext()` path (e.g. `src/commands/secrets.ts:1052`,
  `:1642`) — a background agent process must not silently raise a Touch ID sheet on
  the interactive user's screen. It reads from the broker or fails loudly; it does not
  prompt behind the user's back.
- **The broker holds resolved env in memory only.** `agents secrets unlock` caches the
  resolved bundle behind a `0700` Unix socket (`src/lib/secrets/agent.ts`,
  `session-store.ts`) so Path A stays promptless across concurrent runs — still no
  stdout exposure. See [08-secrets-agent-process-model.md](../../apps/cli/docs/08-secrets-agent-process-model.md).
- **Auto-mode classifiers.** In hosted agent harnesses, an attempt to scan bundles or
  materialize a value (`secrets show`, bulk `--reveal`) is challenged as credential
  exploration — a runtime backstop on top of this design, not a substitute for it.

## What this boundary does NOT do

Inherited from the reference doc's [Security model](../../apps/cli/docs/secrets.md#security-model),
restated here because they bound *this* boundary too:

- **Path A env is inherited by the whole subprocess tree.** A value injected into a
  child is visible to everything that child spawns (npm lifecycle scripts, shells).
  Only bundle credentials you're willing to expose to the agent's full subprocess tree.
- **`never`-policy bundles have no gate at all.** A `never` bundle is stored *without*
  the biometry ACL (`set-no-acl` in `keychain-helper.swift`) and reads fully silently.
  It is the on-disk-plaintext-equivalent downgrade the rest of the model avoids —
  never put a high-value secret in one.
- **Same-user trust is conceded.** The keychain ACL is user-presence, not code-identity;
  any same-user process that pops the prompt can read. This doc is about not
  *gratuitously* widening that to "and it's in the agent's transcript too."

## Decision

Keep the two paths **structurally separate and named**: Path A (`exec` / `--secrets`)
is the default for every agent-driven flow and never materializes; Path B (`export
--plaintext` / `view --reveal` / `get`) exists only for deliberate human-at-a-TTY use.
The design guarantee is that *reaching for a normal secrets-injecting command cannot
accidentally print a secret into an agent's context* — materialization is always an
explicit, differently-named opt-in.

## See also

- [secrets.md](../../apps/cli/docs/secrets.md) — full reference (commands, backends, recipes, ACL threat model)
- [08-secrets-agent-process-model.md](../../apps/cli/docs/08-secrets-agent-process-model.md) — where the broker lives as a process
