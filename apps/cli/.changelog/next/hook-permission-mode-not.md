- **New hook predicate `matches.permission_mode_not` — gate a hook OFF in one
  mode without enumerating every other one.** The existing `permission_mode` is
  an allowlist, so "run everywhere except plan mode" had to be spelled as a list
  of every other mode — and that list silently stops matching the moment a
  harness adds or renames one, which for a guard means it quietly stops
  guarding. The new predicate names the mode to skip instead, so an unknown mode
  still fires: the failure direction is "ran unnecessarily", never "did not
  run". Same fail-open-on-absence rule as its positive twin (a harness that
  reports no mode keeps firing), reads both `permission_mode` and Grok's
  camelCase `permissionMode`, and ANDs with the positive form when both are
  declared. Motivation, measured from `~/.agents/.cache/perf/perf.db`: nine
  guards fire on **every** `Bash` tool call for a combined 292 ms before the
  command runs, across 285,667 recorded fires of which 284 (0.099%) changed the
  outcome — and four of them (`merge-guard`, `pr-description-reminder`,
  `large-file-add-guard`, `git-require-clean-tree`) cannot fire meaningfully
  during a planning turn. Source: `apps/cli/src/lib/hooks/match.ts`,
  `apps/cli/src/lib/types.ts`, `apps/cli/docs/hooks.md`.
