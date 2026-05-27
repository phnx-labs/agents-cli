# Write User-Facing Documentation

For public interfaces: CLIs, APIs, tools, libraries.

Frame around what users want to do — not a regurgitation of `--help`.

## Core principles

**Questions, not commands.** Format sections as literal questions users would ask:
- "How do I automate a site that blocks bots?"
- "I don't want to log in every time"
- "I have multiple accounts and want to keep them separate"

**Situations, not syntax.** "I just generated a new API key in the browser — how do I save it?" beats "Use `--value-stdin` to pipe input."

**Why not X?** Start with a comparison section that honestly positions against alternatives. Research the actual competition — clone their repos, read their code. Never make claims you haven't verified.

**The 20% that delivers 80%.** Don't list every command. Identify the 5 things users actually want to do, then show how.

**End with "What else can I do?"** Point to `--help` for the long tail. The skill doc isn't a reference manual.

## Before writing

1. **Who is the audience?** Developer? Agent user? End user? Frame accordingly.
2. **What are they trying to accomplish?** List the top 5 goals as questions.
3. **What's the competition?** Research honestly. Clone repos if needed. No false claims.
4. **What's our actual edge?** Must be backed by code or architecture.

## Anti-patterns

- Listing all commands with their flags
- "This tool does X" instead of "You want to do X? Here's how"
- Copying `--help` output into markdown
- Making claims about competitors without checking their code
- Technical jargon without context
- Explaining what instead of why

## Example: Bad

```markdown
## Commands

### `browser start`
Starts a browser task.

Options:
- `--profile` - Browser profile to use
- `--task` - Task ID (optional)
```

## Example: Good

```markdown
## "I don't want to log in every time"

Log in once to a profile — the session persists. Every future task is already authenticated:

\`\`\`bash
agents browser profiles create social --browser chrome
agents browser start setup --profile social
# Log in manually, then stop

# Next time — already logged in
agents browser start post --profile social
\`\`\`
```

## Honest competition

When comparing to alternatives:
1. Actually clone their repo and read their code
2. Verify any claims about what they do or don't support
3. If they're good at something, say so
4. Our edges must be backed by actual implementation differences
