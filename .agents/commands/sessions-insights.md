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

## Required read on silent stalls

When summarizing the report (or reading `--json`), **always check** friction /
corrections for agent idle patterns:

| Signal | Meaning |
|---|---|
| `silent stall: 5-15m` / `15-60m` / `1h+` | Assistant was last to speak; session sat idle that long before the next user message (timestamp gap ≥ 5m). The model stopped on its own. |
| `resume after silent stall` | User's first message after a silent stall was a resume nudge (`continue`, `keep going`, `resume`, …). |
| `continue / keep going` | User typed a continue-class correction (may or may not follow a long gap). |

Call these out with counts in your summary. Do **not** reframe long gaps as "the
user was slow" when silent-stall signals are present — the agent went silent and
waited for a human ping. Recommend stop-gates, background CI watches, and finishing
the delivery chain without idling.
