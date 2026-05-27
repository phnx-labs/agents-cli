# Write Runbooks

For operational procedures: incidents, deployments, maintenance.

## Core Principle

**Symptoms to actions.** Start from what you observe, end with what to do.

## Structure

```markdown
# Runbook: [Problem/Procedure]

## Symptoms

- What you see (logs, metrics, alerts)
- How to confirm this is the issue

## Diagnosis

1. Check X: `command`
   - If Y, go to Step 2
   - If Z, see [Other Runbook]

2. Check A: `command`
   - Expected output: ...

## Resolution

1. Do X: `command`
2. Verify: `command`
3. Confirm resolution: [metric/log to check]

## Escalation

- If still broken after 15 min: [who to contact]
- If data loss suspected: [emergency procedure]
```

## Anti-Patterns

- Vague steps ("check the logs")
- No decision points
- Missing verification steps
- No escalation path

## Key Elements

1. **Exact commands** — Copy-pasteable
2. **Expected output** — What success looks like
3. **Decision points** — If X then Y, else Z
4. **Time bounds** — When to escalate

Keep it minimal. If it's not needed at 3am, cut it.
