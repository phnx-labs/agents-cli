# `.changelog/` — the conflict-free changelog

`CHANGELOG.md` is a **generated artifact**. Do not edit it by hand. The source of
truth is this directory.

## Adding a changelog note (every user-visible PR)

Drop **one new file** in `.changelog/next/`, named after your ticket or PR so it
never collides with anyone else's:

```
.changelog/next/RUSH-1740.md
```

Put the release note in it — the same `- **Title.** prose … Source: path` bullet
style you'd have written under `## Unreleased`:

```md
- **Short imperative title (RUSH-1740).** One or two sentences on what changed and
  why it matters. Source: `apps/cli/src/lib/foo.ts`.
```

That's it. Because every PR writes a **different file**, two PRs merging at once
never touch the same lines — the changelog can't become a merge hot-spot.

## What happens at release

`scripts/release.sh` (via `scripts/release-changelog.ts`) folds every fragment in
`.changelog/next/` into `.changelog/<version>.md`, deletes the fragments, and
regenerates `CHANGELOG.md` (released versions only, newest first). A release with
an empty queue fails closed — a release must document itself.

## Regenerating the aggregate locally

```
npm run changelog        # rewrites CHANGELOG.md from .changelog/*.md
```

The test suite asserts the committed `CHANGELOG.md` matches the generator output,
so drift is caught in CI.
