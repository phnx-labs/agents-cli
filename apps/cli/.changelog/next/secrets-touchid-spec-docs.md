- **Docs: the per-command secrets Touch-ID contract is now written down and
  accurate.** The `view --reveal` (1.22.14) and `exec` (1.22.21) interactive-unlock
  changes shipped in code + CHANGELOG only; the reference docs still implied every
  value command behaves the same. `docs/secrets.md` and the `secrets` skill now
  carry an explicit Touch-ID matrix (deliberate `view --reveal`/`exec` at a real
  terminal → one sheet on a locked bundle; `get`/`export` automation primitives →
  never prompt, fail closed to `agents secrets unlock`; anything an agent launches →
  broker-only), `specifications.md` adds **SEC-13b** + a `Prompts?` column on the
  materialization table + `GWT-S2b`, and the skill's stale hold-window facts are
  corrected (7-day default, screen-lock does not drop the hold). Docs-only; no
  behavior change. Source: `apps/cli/docs/secrets.md`,
  `apps/cli/docs/specifications.md`, `skills/secrets/SKILL.md`.
