- **Agent onboarding cheat sheet and docs drift guard.** Added
  `apps/cli/docs/AGENT-CHEATSHEET.md` as a one-page on-ramp for agents, wired it
  from `apps/cli/AGENTS.md` and `apps/cli/docs/README.md`, and added
  `scripts/verify-docs.sh` (plus a `verify-docs` npm script and CI job) to catch
  broken relative links and missing entry-point wiring before merge.
