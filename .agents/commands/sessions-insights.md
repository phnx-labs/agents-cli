---
description: Analyze recent sessions across harnesses and return evidence-backed actions
agents:
  - claude
  - codex
  - gemini
  - cursor
  - opencode
  - grok
  - kimi
  - droid
---

Run the deterministic local sessions analysis and summarize its action list.

```bash
agents sessions insights --since 30d
```

Forward any arguments to the command. Use repeated `--agent` flags to narrow the
harnesses, `--json` for structured output, and `--narrative` only when the user
explicitly wants coaching from aggregate counts. Never upload raw transcripts.
