# Write Onboarding Docs

For new contributors. Goal: first successful change, fast.

## Core Principle

**One working change, not comprehensive knowledge.** Get them productive, then they learn by doing.

## Structure

```markdown
# Getting Started

## Setup (10 min)

\`\`\`bash
# Clone and install
git clone ...
cd ...
./scripts/install.sh
\`\`\`

## Your First Change (15 min)

1. Find a `good-first-issue` or try this: [specific small task]
2. Make the change in `src/foo/`
3. Test: `./scripts/test.sh`
4. Submit: `git commit && git push`

## Where Things Live

| Area | Path | What's There |
|------|------|--------------|
| Core | `src/core/` | Main logic |
| UI | `src/ui/` | Components |
| API | `src/api/` | Endpoints |

## Getting Help

- Questions: [channel/forum]
- Stuck: [who to ask]
```

## Anti-Patterns

- Dumping all architecture upfront
- Explaining history and decisions
- Tool lists without context
- "Read the wiki" links

## Key Elements

1. **Working setup in 10 min** — Or you've lost them
2. **One specific task** — Not "find something"
3. **Where to look** — Mental map of the repo
4. **Who to ask** — Real human contact

Shorter is better. They'll explore when ready.
