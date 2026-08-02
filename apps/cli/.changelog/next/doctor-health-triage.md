- **`agents doctor` now reads as a triaged health report, not neutral status.**
  The verdict was terse status text ("Verdict: 1 divergent, source ~/.agents 16
  commits behind…") a user had to decode. It is now a severity-ranked health block
  that leads with what is unhealthy, why it matters, and the exact fix — one row
  per finding, tagged with a restrained terminal glyph (`✓` `✗` `⚠` and a subtle
  info dot, colored via chalk to match the man-page voice):
  ```
  Claude@2.1.220
    ✗ unhealthy — 3 issues (1 critical · 2 warnings)

    ✗ critical  ask-user-question-guard — on disk but not wired into settings.json; the hook never fires
                → agents sync claude@2.1.220 --yes
    ⚠ warning   ~/.agents — 16 commits behind origin/main; you're running stale config
                → agents repo pull user
    ⚠ warning   11-activity-log — differs from source
                → agents doctor claude@2.1.220 --fix

    heal what's auto-fixable:  agents doctor claude@2.1.220 --fix
  ```
  A clean install collapses to one green line —
  `✓ healthy — 34 resources reconciled · hooks wired · sources current`. Each
  finding carries an agent-agnostic **severity**: **critical** (silent breakage —
  an unwired hook, a missing/unparseable `settings.json`, a MISSING resource),
  **warning** (stale/drift — a source layer behind origin, a DIVERGENT resource, a
  stale/never-synced version), or **info** (an orphan/EXTRA resource →
  `agents prune cleanup`). Both surfaces get the same treatment: the target report
  `agents doctor <agent>@<version>` and the bare `agents doctor` overview, which
  now opens with a `Health` banner aggregated across every installed version. The
  existing per-resource detail rows are kept — the health block layers on top of
  them as the verdict. `--json` gains a `verdict` field (target mode) and a
  `health` field (overview), each carrying `severity`/`category`/`subject`/
  `impact`/`fix` per issue; the existing `summary`/`kinds`/`hookWiring`/
  `sourceBehind`/`sync`/`orphans` fields are unchanged. Source:
  `apps/cli/src/commands/doctor.ts` (`computeVerdict`, `computeOverviewHealth`,
  `healthBlockLines`, `renderHealthBlock`, `verdictIsAutoFixable`).
