# Write Changelogs

For release notes. User impact, not implementation.

## Core Principle

**What changed for users, not what you did.** Group by impact, not by commit.

## Structure

```markdown
# v1.2.0

## Breaking Changes

- `foo` flag renamed to `bar` — update your scripts

## New

- Export to PDF: `tool export --pdf`
- Dark mode support

## Fixed

- No longer crashes on large files
- Memory leak in long sessions

## Improved

- 2x faster startup
- Better error messages for auth failures
```

## Categories

| Category | What Goes Here |
|----------|----------------|
| Breaking | Requires user action |
| New | Features they can use |
| Fixed | Bugs that affected them |
| Improved | Better experience |
| Security | Vulnerabilities patched |

## Anti-Patterns

- Raw commit messages
- Internal refactors ("cleaned up code")
- Ticket numbers without context
- Technical details users don't need

## Style

- Start with verb: "Add", "Fix", "Remove", "Improve"
- User perspective: "You can now..." not "We implemented..."
- If migration needed, show exact steps

Keep it scannable. Users skim for what affects them.
