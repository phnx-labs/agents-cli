# PHNX-3033 history purge runbook

Status: preparation only. The 2026-08-27 dry run was performed in throwaway mirror clones under `/tmp`. It did not rewrite the primary checkout, push a ref, or modify GitHub. Only the repository owner may run the force-push section.

## Scope proved by the dry run

A fresh `git clone --mirror` plus `git log --all --name-only` and `git filter-repo --analyze` found these 16 reachable confidential or companion paths:

```text
.agents/artifacts/2026-08-20/developer-pain-reddit.html
.agents/artifacts/2026-08-20/developer-pain-reddit.md
.agents/artifacts/2026-08-20/github-stars-playbook.html
.agents/artifacts/2026-08-20/github-stars-playbook.md
.agents/artifacts/2026-08-20/gtm-strategy.html
.agents/artifacts/2026-08-20/gtm-strategy.md
.agents/artifacts/2026-08-20/how-winners-charge.html
.agents/artifacts/2026-08-20/how-winners-charge.md
.agents/artifacts/2026-08-20/launch-post-bodies.html
.agents/artifacts/2026-08-20/launch-post-bodies.md
.agents/artifacts/2026-08-20/launch-venues-and-posts.html
.agents/artifacts/2026-08-20/launch-venues-and-posts.md
.agents/artifacts/2026-08-20/launch-worksheet.html
.agents/artifacts/2026-08-20/launch-worksheet.md
.agents/artifacts/2026-08-20/vibe-kanban-postmortem.html
.agents/artifacts/2026-08-20/vibe-kanban-postmortem.md
```

The analysis report found no rename or old-location entry for this family, including no path below the former `apps/cli` layout. The 16 reachable paths account for 6,312,052 accumulated unpacked bytes and 764,593 packed bytes. No reachable `pricing-models.md` or `pricing-models.html` path exists in the 2026-08-27 mirror; its pricing material is present inside the GTM family. The command nevertheless includes both filename globs so those stated family names are removed if a server-side ref appears before the freeze.

Dry-run result from source `main` `2fe028cc2164a41232d2a0b9795c8a01e1a0407b`:

- `git-filter-repo` version: `31ebad4c8fb3`.
- Reachable commits: 14,634 before; 14,569 after. Sixty-five commits became empty and were removed.
- Rewritten non-empty commits: 12,754, counted from `filter-repo/commit-map` where old SHA differed from non-zero new SHA.
- All 18 filename globs below had zero `git log --all` entries and zero `git rev-list --objects --all` entries after filtering.
- All 3,647 refs remained represented in the throwaway mirror.
- The filtered `main` tree was byte-for-byte identical to the source `main` tree after excluding the target family. Unrelated README history remained 712 reachable commits before and after.

These numbers are evidence for that frozen mirror, not values to assume on execution day. Record fresh values after the merge freeze because new refs or commits will change them.

## Owner pre-flight

1. Announce a repository-wide merge and push freeze. Name an owner and a rollback contact. Do not begin while a merge queue, release train, bot, or human can create refs.
2. Wait for every in-flight merge and CI write to stop. Re-query open PRs and export their number, head repository, head ref, base ref, and head SHA. Three open PRs were visible during preparation; the incident scope previously estimated about nine. Every PR open at execution time must be handled regardless of the count.
3. Record all branches, tags, rulesets, release refs, and the current default-branch SHA. Back up the untouched mirror somewhere private and access-controlled. Keep the backup offline from any later push command.
4. Temporarily arrange the minimum GitHub ruleset/protection exception required for the owner to rewrite affected branches and tags. Do not disable unrelated security controls.
5. Confirm `git-filter-repo` is installed and record its version. One supported installation is `python3 -m pip install --user git-filter-repo`; on macOS, `brew install git-filter-repo` is also supported.
6. Clone from GitHub only after the freeze. Never run this from an existing checkout:

```bash
run_dir="$(mktemp -d /tmp/phnx-3033-history-purge.XXXXXX)"
git clone --mirror git@github.com:phnx-labs/agents-cli.git "$run_dir/agents-cli.git"
cd "$run_dir/agents-cli.git"
git-filter-repo --version
git show-ref | sort > "$run_dir/refs.before"
git rev-list --all --count > "$run_dir/commit-count.before"
git log --all --name-only --format= | sed '/^$/d' | sort -u > "$run_dir/paths.before"
git filter-repo --analyze
```

7. Review `paths.before`, `filter-repo/analysis/path-all-sizes.txt`, and `filter-repo/analysis/renames.txt`. If any new related filename or old location appears, add a specific `--path-glob` for it and repeat the throwaway dry run before proceeding.

## Exact purge command

Run this only inside the fresh frozen mirror. It rewrites local objects and refs in that throwaway mirror; `git-filter-repo` removes the `origin` remote as a safety measure.

```bash
git filter-repo --invert-paths \
  --path-glob '**/gtm-strategy.md' \
  --path-glob '**/gtm-strategy.html' \
  --path-glob '**/how-winners-charge.md' \
  --path-glob '**/how-winners-charge.html' \
  --path-glob '**/launch-venues-and-posts.md' \
  --path-glob '**/launch-venues-and-posts.html' \
  --path-glob '**/launch-post-bodies.md' \
  --path-glob '**/launch-post-bodies.html' \
  --path-glob '**/launch-worksheet.md' \
  --path-glob '**/launch-worksheet.html' \
  --path-glob '**/github-stars-playbook.md' \
  --path-glob '**/github-stars-playbook.html' \
  --path-glob '**/developer-pain-reddit.md' \
  --path-glob '**/developer-pain-reddit.html' \
  --path-glob '**/vibe-kanban-postmortem.md' \
  --path-glob '**/vibe-kanban-postmortem.html' \
  --path-glob '**/pricing-models.md' \
  --path-glob '**/pricing-models.html'
```

Before any push, run the verification commands below against the rewritten mirror. Stop if a target match remains or an unrelated current-tree comparison differs.

## Owner-executed force-push

This section is intentionally not executed by the preparer. It changes the public repository irreversibly from ordinary collaborators' perspective.

After local verification, the owner restores the remote and force-updates every branch and tag. The explicit heads/tags refspecs avoid attempting to write GitHub's read-only pull-request refs:

```bash
git remote add origin git@github.com:phnx-labs/agents-cli.git
git push --force --prune origin 'refs/heads/*:refs/heads/*'
git push --force --prune origin 'refs/tags/*:refs/tags/*'
```

Check both push results. A protected or rejected ref means the purge is incomplete; fix the protection/permission cause and retry the same frozen mirror. Never substitute a partial list of branches.

Every affected commit and every descendant of it receives a new SHA; commits made after the purge point are therefore rewritten even when their own file changes are unrelated. Tags pointing into affected ancestry also move. GitHub pull-request refs are regenerated by GitHub rather than pushed directly.

## Blast radius and recovery

- Every fleet device and developer clone is stale immediately after the push. The safest recovery is a fresh clone. A retained clone must fetch with pruning and hard-reset every local branch intended to track a rewritten remote branch; delete stale local tags and fetch the rewritten tags. Never push an old local branch, tag, bundle, or cached mirror back to GitHub.
- Every open PR must be recreated or rebased onto rewritten history, then force-updated by its author. Close superseded PRs only after recording their replacement. Treat the pre-flight PR export as the checklist.
- Pause bots, worktrees, merge queues, release automation, and fleet agents until their clones are replaced or reset. Existing linked worktrees inherit stale object identity and should be recreated.
- Forks, caches, prior clones, PR diffs, and archives may retain the already-public material. This purge removes it from reachable history in the canonical repository; it cannot revoke copies already fetched.
- Published npm tarballs are unaffected. `cli/package.json` ships an explicit `files` allowlist containing built output, installer scripts, changelog, README, and license; it does not ship `.agents/`.

## Verification before and after the push

In the rewritten mirror before pushing, and again in a brand-new post-push mirror clone, require all checks to pass:

```bash
for name in \
  gtm-strategy how-winners-charge launch-venues-and-posts \
  launch-post-bodies launch-worksheet github-stars-playbook \
  developer-pain-reddit vibe-kanban-postmortem pricing-models
do
  for ext in md html
  do
    test -z "$(git log --all --format='%H' -- "**/$name.$ext")" || exit 1
  done
done

test -z "$(git rev-list --objects --all | rg -i \
  'gtm-strategy|how-winners-charge|launch-(venues-and-posts|post-bodies|worksheet)|github-stars-playbook|developer-pain-reddit|vibe-kanban-postmortem|pricing-models')"

git show-ref | sort
git rev-list --all --count
```

Then complete this checklist:

- Compare the rewritten default-branch tree with a trusted pre-purge tree after excluding the 18 target globs; there must be no unrelated tree change.
- Compare the server's full branch and tag inventory with the frozen pre-flight export. Account explicitly for any intentionally removed empty ref.
- Verify each target path on every rewritten branch and tag, not only `main`.
- Fresh-clone from GitHub and repeat both zero-match commands above. Do not verify from a pre-push clone.
- Confirm old raw GitHub URLs and commit-path URLs no longer serve the files from reachable canonical refs. Request GitHub Support cache cleanup if an old object remains directly retrievable.
- Re-enable branch rules, merge queues, bots, fleet agents, and releases only after the fresh-clone verification passes.
- Recreate/rebase every PR from the pre-flight export and wait for green CI plus non-author review again.
- Spot-check an unrelated early commit, current README history, the default-branch tree, and release tags.
- Record the before/after SHAs, commit-map summary, command output, fresh-clone verification, and recovery completion on PHNX-3033. Keep confidential file contents out of the ticket and PR.

The incident remains open until the owner executes the force-push and the post-push fresh-clone verification succeeds.
