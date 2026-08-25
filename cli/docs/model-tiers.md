# Model cost tiers

Audience: maintainers, and agents choosing a teammate's model.

An orchestrating agent picks a model per teammate across many harnesses. Concrete
model ids are the wrong thing to ask it for: names churn (`opus-4-6 → opus-5`;
OpenAI's `high/xhigh` reasoning levels became the **Sol/Terra/Luna** series), the
supported set varies per installed version, and billing differs per harness
(Claude/Codex/Gemini are per-token API; Grok/Kimi/Cursor are subscription).

So model selection also accepts four stable, cost-first **tiers**:

```
cheap    default    best    ultra
```

Pass one anywhere `--model` is accepted — `agents run <agent> --model best`,
`agents teams add <team> <agent> "<task>" --model cheap`, or a custom harness. Concrete
ids (`claude-opus-4-8`) keep working unchanged; tiers are additive.

A tier resolves **per `(harness, installed version)`** to a concrete model that
version actually ships. Because it resolves against that version's own catalog,
it can only ever pick a supported model — `--model ultra` on a Claude build with
no Fable clamps down to `best`, not a model the harness can't run.

## Ranking signal, in priority

The catalog's models are ordered cheapest → most capable by the best signal
available:

1. **Provider-declared lineup** — the catalog's own family names / descriptions.
   The provider tells us its ranking, so this is the most drift-proof signal.
2. **Per-token price** (`prices.json`) — cross-checks the lineup, drives the
   `~$/Mtok` display and budgeting, and orders anything the lineup doesn't.
3. **Size-token heuristic** — `nano|mini|lite|flash|highspeed` cheaper;
   `pro|max|opus|sol` dearer.
4. **Reasoning effort** for single-model harnesses — the tiers steer
   `--reasoning-effort` (there is only one model to pick).

Ranked models are collapsed by family (keeping the **newest** concrete id) and
mapped onto the four tiers. Fewer than four distinct rungs → the top tiers share
a rung and are marked *clamped*. An empty catalog → the tier is unresolvable and
the caller drops the `--model` flag (harness default) rather than forwarding a
bogus token.

**Tiers don't apply to a custom harness.** A custom harness (`agents harness add`, run
via `agents run <name>`) gets its model from its endpoint, not the host harness's
catalog — so a tier on a custom-harness run would forward an incompatible host-harness
model. A tier passed to a custom harness is ignored with a standout warning and the
harness's own configured model is used; a concrete `--model <id>` still works. (These
are also reachable through the legacy `agents profiles` alias.)

## Model ranking mechanisms, per provider

Each provider defines its own capability ladder and encodes it in model names and
descriptions. The mechanism differs and **drifts across versions**, which is why
tiers resolve against the installed version's catalog.

| Provider (harness) | Ranking mechanism |
| --- | --- |
| **Anthropic** (Claude) | Named families, stable across releases: `haiku < sonnet < opus < fable` (+ `mythos`). Version is a suffix (`opus-4-8`, `opus-5`). Reasoning is a separate `--effort` dial. |
| **OpenAI** (Codex) | *Evolving.* Legacy: one family with reasoning levels (`low..xhigh`). The 5.6 line is a named series the CLI self-describes: **Sol** (frontier) > **Terra** (balanced) > **Luna** (fast/affordable), plus `gpt-5.5/5.4/5.4-mini/5.3-codex-spark`. An older Codex maps the tiers onto *its* lineup. |
| **xAI** (Grok) | A single model; the ladder is reasoning effort, not model choice. |
| **Moonshot** (Kimi) | A K-series (`k2.7 < k3`) with `-highspeed` / `-256k` variants; subscription, no per-token price. |
| **Cursor** | Aggregator: re-exposes provider models with effort/speed baked into the id (`claude-opus-5-thinking-high`). Ids are normalized to a base model, then ranked by the provider lineup / price. |
| **Factory** (Droid) | Aggregator with its own **credit-multiplier** economy (0.55x…4x) and no models list command — so a small curated tier map, capped at 2x (`cheap` GLM-5.2, `default` Kimi K3, `best`/`ultra` Opus 5). |

## Permission modes (separate axis)

`--mode plan|edit|auto|skip` is **not** a model pick — it is permissions (how much the
agent can do). Discover what a harness accepts with:

```
$ agents modes claude
$ agents modes cursor --json
$ agents modes                 # every non-deprecated harness
```

That is the modes counterpart of `agents models`. See `agents modes --help`.

## Inspecting the map — the discovery menu

`agents models [agent[@version]]` is the one command an agent (or human) reads to pick a
model. It prints the resolved tier map — with `~$/Mtok` where priced — and stays compact
(the raw model list is behind `--all`); `--json` emits `catalog` + `tiers`:

```
$ agents models codex@0.146.0
Codex 0.146.0
  tiers:
    cheap    gpt-5.6-luna  ~$7/Mtok
    default  gpt-5.6-terra  ~$18/Mtok
    best     gpt-5.6-sol  ~$35/Mtok
    ultra    gpt-5.6-sol  ~$35/Mtok  (clamped)
  8 models · `agents models codex --all` for the full list

$ agents models                    # no arg -> the tier map for every installed harness
$ agents models codex --all        # + the raw catalog
```

## Overriding a tier — when the guess is wrong

The auto-ranking is a best guess; for a subscription harness with no price signal it can
be wrong. Pin the right model with a command — you never hand-edit config:

```
$ agents models tier set kimi best kimi-code/k3                # per harness
$ agents models tier set kimi@0.19.2 best kimi-code/k3-256k    # a specific version wins
$ agents models tier clear kimi                                 # back to the auto guess
$ agents models tier list
```

Overrides are stored under `model.tiers` in `agents.yaml` (same selector shape as
`run.defaults`) and resolve **most-specific-first**: `<agent>:<version>` → `<agent>:*` →
auto. An overridden id that a given version doesn't ship falls back to auto for that
version (never a dead id). `agents models` marks an overridden tier `[override]`. Some
subscription harnesses ship a **curated** default ladder (e.g. Kimi: `k2.7-highspeed` <
`k2.7-coding` < `k3`), so the common case is right without any override.

## Source

- `apps/cli/src/lib/model-tiers.ts` — `MODEL_TIERS`, `isTierToken`, `tierizeModels`,
  `resolveTierMap`, `resolveTier`.
- `apps/cli/src/lib/models.ts` — catalog extraction (incl. the Claude id-scan
  floor) and per-model pricing.
- `apps/cli/src/lib/exec.ts` — `buildExecCommand` resolves a tier token to a model
  for both `agents run` and `agents teams`.
- `apps/cli/src/lib/model-tier-overrides.ts` — user overrides in `agents.yaml` (`tier set/clear/list`).
- `apps/cli/src/commands/models.ts` — the compact `agents models` menu, `--all`, `--json`, and the `tier` subcommands.
- `apps/cli/src/lib/pricing/prices.json` — per-token USD table (the ranking
  cross-check and `$/Mtok` display).
