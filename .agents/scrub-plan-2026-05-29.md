# agents-cli OSS Pre-Launch Git-History Scrub Plan

Generated 2026-05-29 by parallel research agent. **PLAN ONLY — do not execute without explicit confirmation.**

## Scan basis

- 2,294 commits, 90 refs, 47 tags, 2 remotes (`origin` = `phnx-labs/agents-cli`, `mirror` = `muqsitnawaz/agents-cli`)
- Repo timeline: 2026-02-07 → 2026-05-29
- Gitleaks (`/opt/homebrew/bin/gitleaks` v8+) on `--log-opts="--all"` returned **`no leaks found`** in 2.15s
- Conclusion: **zero credentials/API keys/JWTs/PEMs leaked.** The leaks are identifiers + infra metadata, not auth secrets.

## Findings

### 1A — Author identity (BLOCKING for OSS)

- **Personal Gmail on 1,259 of 2,294 commits**: `muqsitnawaz@gmail.com` (first commit `1f6af21d` "feat: initial standalone agents-cli repo", continuous through HEAD)
- Other author emails seen: `13007401+muqsitnawaz@users.noreply.github.com` (good), `276978950+prix-cloud[bot]@users.noreply.github.com`, `agent@agents.dev`, `bot@getrush.ai`, `test@example.com`

### 1B — Personal email in commit content

- `muqsit@trp.so` in 13 commits as test fixture data. Earliest: `5ee26327`. Already sanitized at HEAD to `user-a@example.com` per commit `911c4ea7`. Old commits still recoverable via `git show <sha>`.

### 1C — Internal infra hostnames at HEAD (60 files, 223 line-hits) — POLICY decision per item

- `hetzner.com` + `HCLOUD_TOKEN` — `AGENTS.md:143`, `scripts/sandbox.sh:38`, `.agents/skills/crabbox/SKILL.md` lines 14-34
- `api.prix.dev` hard-coded as PROXY_BASE — `src/lib/cloud/rush.ts:29`, `src/lib/session/cloud.ts:20`. Earliest `7ddab2f4`. **Product behavior, not accident** — locks OSS users to your proxy unless overridden.
- `mac-mini` — pentest skills + old session fixture. Sanitized at HEAD; old commits still have `ssh muqsit@mac-mini`.
- `crabbox` (internal-only tooling name) — 8 hits in skills/scripts/workflows/AGENTS.md. Earliest `e2b554c3`.
- `muqsitnawaz` GitHub handle in source paths — `.agents/skills/crabbox/SKILL.md:89,147`. Earliest `1f6af21d`.
- `phnx-labs` / `security@phnx-labs.com` — `SECURITY.md` reporting email, intentional.
- `swarmify` (legacy package name) — `scripts/release.sh:24`, `packages/swarmify-mirror/*`. Earliest `1f6af21d`.
- `byphoenix.com` — only as example target in `.agents/skills/audit/pentest-web.md:3` and a negative test in `website/test/landing.test.ts:38`.

### 1D — Internal Linear ticket refs in commit subjects

10+ commits with `RUSH-XXX` suffixes that map to your private Linear workspace:
- `8ce0f232 feat(browser): detect rich-text editor frameworks (RUSH-685)`
- `e1ff2bf5 fix: shim repair loop, missing versions migration, soft-delete prune (RUSH-664)`
- `cd7f3f40 fix(security): pipe keychain secret via stdin to security -i (RUSH-557)`
- `a89e92d2 fix(security): add safeJoin() to block path traversal in fs ops (RUSH-555)`
- `913f294f feat: surface signal in agents sessions view summary (RUSH-391)`
- `bc71a428 feat: add cross-session artifact read access (RUSH-167)`
- +6 more matching `RUSH-\d+`

### 1E — Pentest skills enumerate full internal infra in OSS source

`.agents/skills/audit/pentest-infra.md:39,53,55,56` document `ssh muqsit@mark "systemd-analyze security prix-api"`, `/etc/prix-api/env` paths, Cloudflare/Supabase/Vercel topology. Earliest `48f199c1`. **Decision needed**: keep as OSS documentation of audit skill capability, OR move to private skill, OR generalize examples.

### Rewrite depth

| Leak class | Earliest commit | Action | Commits-rewritten |
|---|---|---|---|
| `muqsitnawaz@gmail.com` author email | `1f6af21d` (initial) | mailmap | **all 2,294** |
| `muqsit@trp.so` content | `5ee26327` | filter-repo replace | ~600+ |
| `swarmify`, `muqsitnawaz/agents` path | `1f6af21d` | filter-repo replace | **all 2,294** |
| `RUSH-XXX` Linear refs in subjects | `913f294f` | filter-repo `--message-callback` | ~1500 |
| `mac-mini` in old test fixture | `913f294f` | filter-repo replace | ~1500 |
| `crabbox`, `hetzner.com` infra refs | `e2b554c3` | scrub or own | ~400 |

Since author email touches every commit, **the rewrite must cover entire history** — no "shallow" option.

## Tool recommendation: `git filter-repo`

- NOT `git filter-branch` (per git-scm docs: "WARNING: pitfalls... performance issues... use is not recommended")
- NOT BFG Repo Cleaner — your leaks are string patterns, not big blobs; BFG can't rewrite commit messages or mailmap in one pass
- `git filter-repo` combines mailmap + content replace + message rewrite in one pass, finishes 2,294 commits in <1 min

Install: `brew install git-filter-repo`

## Execution plan (DO NOT RUN THIS SESSION)

### Phase 0 — Backups (mandatory)

```bash
mkdir -p ~/scrub-backups/$(date +%Y-%m-%d)
cd ~/scrub-backups/$(date +%Y-%m-%d)
git clone --mirror git@github.com:phnx-labs/agents-cli.git phnx-origin.git
git clone --mirror git@github.com:muqsitnawaz/agents-cli.git muqsitnawaz-mirror.git
tar czf phnx-origin-backup.tgz phnx-origin.git
tar czf muqsitnawaz-mirror-backup.tgz muqsitnawaz-mirror.git
# Move one copy to external drive / 1Password / iCloud.

gh pr list --repo phnx-labs/agents-cli --state open --json number,headRefName,baseRefName,title > open-prs-before-scrub.json
```

### Phase 1 — Prepare rewrite inputs

```bash
mkdir -p ~/agents-cli-scrub && cd ~/agents-cli-scrub
git clone --mirror git@github.com:phnx-labs/agents-cli.git agents-cli.git
cd agents-cli.git

cat > mailmap.txt <<'EOF'
Muqsit Nawaz <13007401+muqsitnawaz@users.noreply.github.com> Muqsit <muqsitnawaz@gmail.com>
Muqsit Nawaz <13007401+muqsitnawaz@users.noreply.github.com> Muqsit Nawaz <muqsitnawaz@gmail.com>
agents-cli bot <bot@phnx-labs.com> Prix Cloud Agent <bot@getrush.ai>
agents-cli bot <bot@phnx-labs.com> prix-cloud[bot] <276978950+prix-cloud[bot]@users.noreply.github.com>
agents-cli bot <bot@phnx-labs.com> Agent <agent@agents.dev>
EOF

cat > replace.txt <<'EOF'
muqsit@trp.so==>user@example.com
muqsit@phoenix.dev==>user@example.com
muqsit@getrush.ai==>user@example.com
muqsitnawaz@gmail.com==>13007401+muqsitnawaz@users.noreply.github.com
regex:ssh muqsit@mac-mini==>ssh user@remote-host
regex:ssh muqsit@mark==>ssh user@remote-host
regex:muqsit@mac-mini==>user@remote-host
regex:muqsit@mark==>user@remote-host
github\.com/muqsitnawaz/agents/harness==>github.com/agents-cli/agents/harness
~/src/github\.com/muqsitnawaz/agents-cli==>~/src/agents-cli
EOF

cat > strip-rush-tickets.py <<'EOF'
import re
def message_callback(msg):
    return re.sub(rb' ?\(RUSH-\d+\)', b'', msg)
EOF
```

### Phase 2 — Rewrite

```bash
git filter-repo \
  --mailmap mailmap.txt \
  --replace-text replace.txt \
  --message-callback "$(cat strip-rush-tickets.py | tail -n +2)" \
  --force

# Verify locally
git log --all --format="%ae" | sort -u   # expect NO muqsitnawaz@gmail.com
git log --all -p -S "muqsit@trp.so" | head      # expect empty
git log --all --format="%s" | grep -E "RUSH-[0-9]+" | head  # expect empty
gitleaks detect --source . --no-banner --log-opts="--all"
```

### Phase 3 — Force push

```bash
git remote add origin git@github.com:phnx-labs/agents-cli.git
git remote add mirror git@github.com:muqsitnawaz/agents-cli.git

git push origin --force --all
git push origin --force --tags
git push mirror --force --all
git push mirror --force --tags
```

### Phase 4 — Open-PR rebase (currently #57, #58, #60, #71-#77, plus any new)

For each PR branch, every parent SHA changed, so each branch must be re-anchored:

```bash
gh pr checkout <PR-NUMBER> -R phnx-labs/agents-cli   # in a fresh clone
git fetch origin main
git rebase --onto origin/main $(git merge-base HEAD origin/main) HEAD
# Resolve any conflicts, run gates.
git push --force-with-lease
```

Add PR comment: `History was rewritten on YYYY-MM-DD for OSS pre-launch. Rebased onto new main. Please re-review.`

### Phase 5 — Verify

```bash
cd /tmp && rm -rf verify && git clone git@github.com:phnx-labs/agents-cli.git verify
cd verify

gitleaks detect --source . --no-banner --log-opts="--all"          # expect no leaks
git log --all --format="%ae" | sort -u                              # no gmail
git log --all -p -S "muqsit@trp.so" | head -1                        # empty
git log --all -p -S "muqsitnawaz@gmail.com" | head -1                # empty
git log --all --format="%s" | grep -cE "RUSH-[0-9]+"                # 0
git log --all -p -S "ssh muqsit@" | head -1                          # empty
```

### Phase 6 — Comms template

```
Subject: agents-cli history rewrite — please re-clone

We rewrote the agents-cli git history on YYYY-MM-DD to scrub personal
identifiers and internal infra references before OSS launch. SHAs changed
on every branch.

Action required:
  1. Save any local WIP that isn't pushed (git diff > my-wip.patch).
  2. Delete your local clone: rm -rf ~/path/to/agents-cli
  3. Re-clone: git clone git@github.com:phnx-labs/agents-cli.git
  4. Re-apply your WIP: git apply my-wip.patch

DO NOT git pull on the old clone — it will recreate the pre-scrub
history locally.
```

## Key findings recap

- **Zero credentials leaked.** Gitleaks all-history scan: `no leaks found` (2,294 commits, 66.13 MB).
- **Biggest risk is doxxing, not credential theft.** `muqsitnawaz@gmail.com` is the author of 1,259 of 2,294 commits.
- Content leaks: 13 commits with personal email in test data (already at HEAD scrubbed), ~10 commits with internal Linear ticket IDs, ~60 files at HEAD referencing internal infra.
- One pass of `git filter-repo` handles all personal-identity items. Infra-name decisions are policy questions, not scrub mechanics.
- All currently-open PRs need rebase after force-push.
