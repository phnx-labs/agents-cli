- **Workflows sync through one per-harness registry (PHNX-3993).** How each
  workflows-capable harness stores a synced workflow (Claude bundle dir, Kimi flow
  skill, Antigravity global_workflows file, Goose recipe, OpenClaw Lobster, Grok
  Rhai) is declared once in `WORKFLOW_TARGETS`; sync, list, remove, the `agents
  doctor` drift check, and the staleness detector are generic over it, where they
  previously each branched on the harness id and the detector kept its own copy of
  the ownership-marker parsers. Paths, markers, and error text are unchanged; a
  foreign Kimi `<name>/` skill dir now blocks a sync the same way a foreign file
  blocks the other harnesses instead of being written into. A completeness test
  pins the table to `capableAgents('workflows')`. Source:
  `cli/src/lib/workflows-registry.ts`.
