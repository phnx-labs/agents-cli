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
`agents teams add <team> <agent> "<task>" --model cheap`, or a profile. Concrete
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

## Inspecting the map

`agents models [agent[@version]]` prints the resolved tier map for a version, with
`~$/Mtok` where priced, and emits it under `tiers` in `--json`:

```
$ agents models codex@0.146.0
Codex 0.146.0
  tiers:
    cheap    gpt-5.6-luna  ~$7/Mtok
    default  gpt-5.6-terra  ~$18/Mtok
    best     gpt-5.6-sol  ~$35/Mtok
    ultra    gpt-5.6-sol  ~$35/Mtok  (clamped)
  ...

$ agents models grok
  tiers:
    cheap    grok-4.5 @low   --
    ultra    grok-4.5 @xhigh --
```

## Source

- `apps/cli/src/lib/model-tiers.ts` — `MODEL_TIERS`, `isTierToken`, `tierizeModels`,
  `resolveTierMap`, `resolveTier`.
- `apps/cli/src/lib/models.ts` — catalog extraction (incl. the Claude id-scan
  floor) and per-model pricing.
- `apps/cli/src/lib/exec.ts` — `buildExecCommand` resolves a tier token to a model
  for both `agents run` and `agents teams`.
- `apps/cli/src/commands/models.ts` — the `agents models` tier display + `--json`.
- `apps/cli/src/lib/pricing/prices.json` — per-token USD table (the ranking
  cross-check and `$/Mtok` display).
