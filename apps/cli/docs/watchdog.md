# Watchdog

The watchdog keeps AI coding agents moving. Agents are expected to drive their task
to completion, but they routinely **go idle** — announce a step and never take it,
finish a thought and stall, or ask themselves a question they could answer. Those
idle sessions surface nowhere and quietly waste time. The watchdog's job is to find
them, understand each one, and steer it to finish.

> Normative requirements (MUST/SHOULD, cited to `file:line`) live in
> [specifications.md#watchdog](specifications.md#watchdog). This doc is the how-it-works.

## Strategy: idle → completion

The single goal is **get idle agents moving to completion**. Everything else follows
from that one focus.

**Idle is the watchdog's territory; waiting is the feed's.** A session that explicitly
stopped on a question or a permission prompt (`waiting_input`) already surfaces in the
user's feed — the user can act on it there, so the watchdog leaves it alone. A session
that is merely **idle** — stopped with no prompt, nothing surfacing it — is the silent
tax the watchdog exists to remove. This division is why accurate status detection is the
watchdog's #1 dependency: it must reliably tell `idle` (its job) from `waiting_input`
(the feed's), `working` (leave alone), and completed (nothing to do).

## The loop

The watchdog is a **daemon-fired routine**, not a live process: the scheduler runs
`agents watchdog --nudge` on a cron cadence (`WATCHDOG_ROUTINE_SCHEDULE`,
`lib/watchdog/routine.ts`). Each fire is one bounded tick:

1. **Detect idle.** Enumerate active sessions, classify each by transcript freshness and
   inferred activity (`lib/watchdog/read.ts`, `lib/session/state.ts`). A candidate is a
   session that is stalled (idle past `WATCHDOG_STALL_MS`, before `WATCHDOG_DORMANT_MS`,
   past its cooldown) — not `working`, not freshly `waiting` for the feed. Prioritize the
   ones active most recently: a warm session (last activity ~minutes ago) is the one worth
   steering.
2. **Analyze.** For a candidate, read its transcript tail to recover the goal and the
   reason it stopped (`lib/watchdog/watchdogTail.ts`). The deterministic pre-filter
   (`deterministicDecision`, `lib/watchdog/runner.ts`) resolves the two cheap cases —
   a clearly-complete session (skip) and a promise-without-toolcall stall — and escalates
   the judgment-heavy cases to the brain.
3. **Drive it.** The brain decides NUDGE vs SKIP and crafts the message
   (`WATCHDOG_SYSTEM_PROMPT`, `lib/watchdog/watchdog.ts`). A nudge is **help, not a
   shove**: it restates the goal, references the conclusion the agent already reached, and
   names the concrete next step — the exact action, a tool it forgot, or the sensible
   default. Never a generic "keep going."
4. **Escalate only genuine sign-off.** Credentials, a release/publish, an
   irreversible/outward-facing action, or a real product decision → left for the human
   (surfaced in the feed), never nudged.

## The brain

The decider is a real agent, not a template. The default per-tick decision is a cheap
deterministic pre-filter; the judgment-heavy cases escalate to an LLM brain via
`agents run <watchdog-workflow> --mode plan` (`makeDefaultSmartDecider`,
`lib/watchdog/runner.ts`). The prompt is `WATCHDOG_SYSTEM_PROMPT`
(`lib/watchdog/watchdog.ts`); a user playbook at `~/.agents/playbooks/watchdog.md` is
appended as **House Rules** (`composePromptWithPlaybook`) so per-fleet authorization norms
("rolling an already-published version to my own fleet is authorized — proceed") tune the
NUDGE/SKIP line without editing the built-in prompt.

Four rules govern a good nudge:

- **Read, don't guess.** Judge from the transcript (goal + recent reasoning), not a status
  field alone — an agent that already decided needs "do it," not "decide."
- **Carry context.** Restate the goal, reference what it already concluded, name the step.
- **Split the ask.** Drive the reversible, goal-advancing part; surface only the genuinely
  disruptive part — don't stall the whole task on one risky sub-step.
- **Point at the tool it forgot.** If a tool resolves the blocker, name it —
  `agents computer` (drive the local Mac), `agents ssh <mac> "agents computer …"` (drive a
  Mac from elsewhere), `agents browser` — instead of asking the human.

The rules that ban over-asking are already loaded in every agent's context and ignored
anyway (the model's deference reflex overrides explicit instruction). The watchdog is the
**enforcement** layer that the internal instruction cannot deliver — not a reminder.

## Delivery

A nudge is delivered into the exact terminal split the session lives in, resolved by the
single canonical resolver `resolveInjectTargetForSession` (`lib/terminal/resolve.ts`),
precedence `tmux > iterm > vscodium > pty`, then injected by `injectIntoTerminal`
(`lib/terminal/inject.ts`). VSCodium/Cursor/VS Code integrated terminals are addressed via
the extension's `/inject` URI handler. When no addressable split exists the tick falls back
to a mailbox enqueue or a headless `--resume`, and refuses (flags for the menu-bar) only
when nothing can reach the session. `agents sessions inject` shares this same resolver, so
the manual unblock path and the watchdog agree.

## Fleet model

The watchdog reads the **whole fleet** (`agents sessions --active --json` fans out to every
device, status computed on each origin host) but delivers **locally** on each session's
origin box, where injection is reliable. Because routines are fleet-synced git config
(`~/.agents/routines/`), the watchdog routine can run on one always-on box (pin it with
`agents routines devices watchdog --set <host>`) and still see every device, or run
distributed on every box against its own local sessions — see
[routines.md](03-routines.md) and [fleet.md](fleet.md).

## Per-session policy

`agents watchdog policy <id> off|keep|handsoff` — `off` excludes a session entirely;
`handsoff` detects and flags it but never delivers; `keep` (default) is the normal path.

## File map

| File | Role |
|---|---|
| `lib/watchdog/routine.ts` | The cron routine (`agents watchdog --nudge`) the daemon fires. |
| `lib/watchdog/runner.ts` | One tick: enumerate → classify → decide (deterministic + smart) → deliver → log. |
| `lib/watchdog/watchdog.ts` | `WATCHDOG_SYSTEM_PROMPT`, playbook composition, prompt render, response parse. |
| `lib/watchdog/read.ts` | Locate a transcript and read its tail; stall thresholds. |
| `lib/watchdog/watchdogTail.ts` | Summarize a tail into last-user / last-assistant for the brain + log. |
| `lib/watchdog/log.ts` | Append decisions to `watchdog.log` for the Factory activity card. |
| `commands/watchdog.ts` | `agents watchdog` — `enable`/`disable`/`status`/`policy`/`--nudge`/`--watch`. |
| `lib/session/state.ts`, `active.ts` | Status inference (`working`/`waiting_input`/`idle`) the watchdog reads. |
| `lib/terminal/resolve.ts`, `inject.ts` | Resolve the exact split and deliver the nudge. |

## Roadmap

The strategy is landing in stages. Shipped: idle detection, version-home-safe transcript
resolution, the unified inject resolver, and the context-carrying/tool-pointing brain
prompt. Planned: seeding the brain with the full fleet snapshot as its starting context; a
distinct `done` state (so a finished session is never confused with idle); status coverage
for non-Claude/Codex harnesses; and the shipped default `watchdog/WORKFLOW.md` decider.
