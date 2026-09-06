- **`agents run codex` marks an exhausted account so rotation stops re-picking it
  (PHNX-3859).** When a headless codex run ended with `You've hit your usage limit
  … try again at <date>` (or an out-of-credits refusal), that account's throttle
  was never recorded, so the balanced picker kept selecting it from a stale usage
  snapshot and every subsequent run died the same way instead of rotating to a
  healthy sibling. Codex now persists a per-account refusal marker the same way
  Claude already did — the usage cache is identity-keyed and shared across
  harnesses — so `collectRunCandidates` excludes the dead account and picks a
  healthy one. A usage limit is noted with its reset clock (it auto-clears when the
  window resets), a genuine credit/quota exhaustion is noted clock-less (cleared by
  a later successful run), and a limit with no parseable reset is left untouched
  rather than persisted as an unexpirable marker. Source: `cli/src/lib/exec.ts`
  (`classifyCodexRunRefusal`, `parseCodexUsageLimitReset`).
