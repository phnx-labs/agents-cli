---
name: reflect
description: >-
  Recall all feedback, corrections, and constraints from the current
  conversation before rewriting or iterating. Triggers on: reflect,
  step back, reconsider, recall feedback, what did I say, incorporate
  all feedback, or when iterative drafts keep missing the mark.
argument-hint: "[optional: specific topic to reflect on]"
user-invocable: true
---

# Reflect

You are mid-conversation. The user has given you feedback — corrections, preferences, pushback, confirmations. Before your next attempt, you must surface all of it.

## When This Triggers

- User explicitly says "reflect", "step back", "reconsider", "recall what I said"
- You've done 2+ iterations and the user is still unsatisfied
- User says something like "incorporate all my feedback" or "you keep missing X"

## The Process

### Step 1: Enumerate Every Piece of Feedback

Scan the entire conversation. Extract every instance where the user:

- **Corrected you** ("no", "not that", "wrong framing", "that's not what I meant")
- **Rejected an approach** ("don't lead with X", "stop doing Y", "this isn't useful")
- **Confirmed something worked** ("yes", "exactly", "that's the right angle", accepted without pushback)
- **Added a constraint** ("it should feel like...", "the audience is...", "don't mention...")
- **Provided new information** that changes the approach (facts, context, nuance you didn't have before)

Present these as a numbered list. Quote the user's words where possible — don't paraphrase into something softer.

Format:

```
FEEDBACK INVENTORY:

1. [REJECTED] "the first hook isn't really useful — it sounds like scrolls dropping"
   → Thesis statements don't hook. Lead with something concrete/surprising.

2. [CORRECTED] "an agent run by cron can do push notifications to ask for permissions"
   → "Autonomous = unreachable" is wrong. The real issue is latency tolerance, not absence.

3. [CONFIRMED] The per-binary network policy detail — user flagged this as the most interesting finding early on.
   → This should be the anchor, not supporting detail.

4. [CONSTRAINT] Don't sell Rush. No product pitch.
   → Can reference contextually but not promote.

5. ...
```

### Step 2: Identify the Pattern

After listing, ask: what's the *thread* connecting these corrections? Usually the user is pushing toward one thing you keep missing. Name it explicitly.

Example: "The thread: I keep leading with framing and structure instead of a single concrete thing that's genuinely surprising."

### Step 3: State the Revised Approach

Before writing anything new, state in 1-2 sentences what you'll do differently this time, grounded in the feedback inventory.

### Step 4: Execute

Now write the next draft/response with all constraints active simultaneously. Not just the latest correction — all of them.

## Why This Works

Creative iteration fails when the agent treats each correction as a local patch. Feedback is cumulative — correction #5 doesn't replace corrections #1-4. But without explicit recall, agents drift: they fix the latest issue and regress on earlier ones.

This skill forces global constraint satisfaction before each attempt.

## Anti-Patterns

- **Summarizing feedback vaguely** ("you wanted it to be better") — quote specific words
- **Only recalling corrections, not confirmations** — what worked is as important as what didn't
- **Treating this as a delay tactic** — the inventory should take 30 seconds, not become a philosophical exercise
- **Skipping Step 2** — the pattern identification is where the real insight lives
