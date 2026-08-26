---
kind: plan
title: "Unblock git pull: 41 untracked .agents/memories files vs the redacted committed versions"
surface: internal
---

## Focus for review

- The redacted committed versions win in the working tree; the unredacted local originals move to gitignored scratch — confirm that direction is right.
- Backup location: `.agents/scratch/memories-local-2026-08-15/` (gitignored, stays on this box). Nothing is deleted.
- No code, no commits, no branch changes — this only completes the fast-forward you already started.

## Purpose

You ran `git pull` on the agents-cli checkout and it aborted: *"The following untracked working tree files would be overwritten by merge"* — 41 files under `.agents/memories/`. The task is to complete that pull without losing anything.

## Current state

origin/main (`70dafd0a6..e38f58464`, a plain fast-forward) now **tracks** `.agents/memories/*.md`. The committed copies are deliberately **redacted** — session shortids and branch names replaced with `—`, headers normalized (commits `f11d5c167`, `32f78392c`, `811951fbf`) — per the repo policy that committed `.agents/` content is public and anonymized. The 41 local untracked copies are the **unredacted originals** written by agents on this box: they carry real session ids and branch names. Every one of the 41 differs from its committed counterpart, which is why git refuses to overwrite them.

<svg viewBox="0 0 920 250" role="img" aria-label="Resolution flow: back up local originals, fast-forward, redacted versions land">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="ui-monospace, monospace" font-size="13" fill="currentColor">
    <rect x="20" y="30" width="270" height="70" rx="8" fill="none" stroke="currentColor" opacity="0.9"/>
    <text x="35" y="55">.agents/memories/*.md (41)</text>
    <text x="35" y="78" opacity="0.7">untracked · unredacted originals</text>
    <rect x="20" y="160" width="270" height="70" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
    <text x="35" y="185">.agents/scratch/</text>
    <text x="35" y="208">memories-local-2026-08-15/ · kept</text>
    <line x1="155" y1="100" x2="155" y2="155" stroke="currentColor" marker-end="url(#arr)"/>
    <text x="170" y="133" opacity="0.8">1. mv (backup)</text>
    <rect x="380" y="30" width="250" height="70" rx="8" fill="none" stroke="currentColor" opacity="0.9"/>
    <text x="395" y="55">origin/main e38f58464</text>
    <text x="395" y="78" opacity="0.7">tracks redacted memories</text>
    <rect x="680" y="30" width="220" height="70" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
    <text x="695" y="55">working tree</text>
    <text x="695" y="78" opacity="0.7">redacted versions land</text>
    <line x1="630" y1="65" x2="675" y2="65" stroke="currentColor" marker-end="url(#arr)"/>
    <text x="380" y="130" opacity="0.8">2. git pull → fast-forward 70dafd0a6..e38f58464 (no merge commit)</text>
    <text x="380" y="160" opacity="0.8">3. verify: HEAD, status, 41 files in backup</text>
  </g>
</svg>

## Proposed Changes

1. Back up the 41 conflicting local originals into the gitignored scratch dir (confirmed ignored at `.gitignore:52`):

```bash
mkdir -p .agents/scratch/memories-local-2026-08-15
for f in .agents/memories/*.md; do
  git cat-file -e "origin/main:$f" 2>/dev/null && mv "$f" .agents/scratch/memories-local-2026-08-15/
done
```

2. Complete the pull (fast-forward, no merge commit):

```bash
git pull
```

3. Verify:

```bash
git rev-parse HEAD                     # expect e38f58464
git status --short | grep memories     # expect nothing
ls .agents/scratch/memories-local-2026-08-15 | wc -l   # expect 41
```

<div class="artifact-callout"><strong>Nothing is deleted:</strong> the unredacted originals are moved, not removed, and the scratch dir is gitignored so they can never be committed by accident.</div>

## Risks

| Item | Action | Risk |
| --- | --- | --- |
| `.agents/memories/*.md` (41) | mv to `.agents/scratch/memories-local-2026-08-15/` | none — reversible move |
| `.agents/memories/` after pull | tracked redacted versions from origin/main | intended state |
| checkout branch/HEAD | fast-forward `70dafd0a6..e38f58464` | none — the pull you already ran |

## Public Interface

No public surface changes — no commands, flags, or APIs touched. This is a working-tree operation on one checkout: untracked files moved to a gitignored dir, then a fast-forward `git pull`.

## Validation

```bash
git rev-parse HEAD                     # expect e38f58464
git status --short | grep memories     # expect nothing
ls .agents/scratch/memories-local-2026-08-15 | wc -l   # expect 41
```

| Check | Expected |
| --- | --- |
| `git rev-parse HEAD` | `e38f58464` |
| `git status --short \| grep memories` | empty |
| backup file count | 41 |
| spot-check a pulled file | redacted (`—` shortids) |

## Checklist

- [ ] Back up 41 local unredacted memory files to `.agents/scratch/memories-local-2026-08-15/`
- [ ] Re-run `git pull` (fast-forward to `e38f58464`)
- [ ] Verify HEAD, clean status, and backup intact (41 files)
