---
name: release
description: >-
  Publish packages to registries (npm, CDN, etc.). Discovers repo structure,
  scaffolds build/release scripts if missing, runs tests, updates changelog,
  publishes, and tags. Supports monorepos and semver with prereleases.
  Triggers on: release, publish, ship, npm publish, cut a release.
user-invocable: true
version: 1.0.0
author: muqsit
---

# Release

Publish packages to their registries. Works with single packages and monorepos.

## Arguments

`$ARGUMENTS` may contain:
- A version number: `1.2.3`, `1.2.3-alpha.1`, `patch`, `minor`, `major`
- A package path for monorepos: `rush/app`, `harness-ui`
- Flags: `--skip-tests`, `--skip-build`, `--force`

If no version is given, analyze what's needed and suggest one.

---

## Phase 1: Discovery

Before doing anything, check for project-specific release instructions.

### 1.1 Check for project-level overrides

```bash
# Project-level release skill takes precedence
ls .agents/skills/release/ 2>/dev/null

# Check for release instructions in project docs
grep -l -i "release\|publish\|deploy" README.md CLAUDE.md AGENTS.md .agents/*.md 2>/dev/null | head -5
```

If `.agents/skills/release/` exists in the project, defer to it completely. Read those instructions and follow them instead of this skill.

### 1.2 Detect repo structure

```bash
# Is this a monorepo?
if [[ -f "package.json" ]]; then
  # Check for workspaces
  jq -e '.workspaces' package.json 2>/dev/null && echo "MONOREPO: npm/bun workspaces"
fi

[[ -f "pnpm-workspace.yaml" ]] && echo "MONOREPO: pnpm workspaces"
[[ -f "lerna.json" ]] && echo "MONOREPO: lerna"

# Find all package.json files
fd -t f package.json --max-depth 3 | head -20
```

### 1.3 Identify publishable packages

```bash
# List packages that are NOT private
fd -t f package.json --max-depth 3 -x sh -c '
  name=$(jq -r ".name // empty" "{}")
  private=$(jq -r ".private // false" "{}")
  if [[ -n "$name" && "$private" != "true" ]]; then
    echo "{}: $name"
  fi
'
```

### 1.4 Find release scripts

```bash
# Standard locations
ls scripts/release.sh scripts/build.sh release.sh 2>/dev/null

# Monorepo subdirs
fd -t f release.sh --max-depth 4

# Check for npm scripts
jq -r '.scripts | keys[]' package.json 2>/dev/null | grep -E 'release|publish|deploy'
```

### 1.5 Monorepo: Ask which package

If multiple publishable packages are found and `$ARGUMENTS` doesn't specify one, use `AskUserQuestion` to ask which package to release. List all discovered packages with their current versions.

---

## Phase 2: Infrastructure Check

### 2.1 Check for existing scripts

If `scripts/release.sh` exists, read it to understand:
- Does it have dry-run mode? (look for `--apply`, `--confirm`, `--dry-run`)
- Does it run tests? (look for `npm test`, `bun test`, `build.sh`)
- What registry does it publish to? (npm, CDN URL, etc.)

### 2.2 Scaffold if missing

If no release script exists, offer to create the standard structure:

**scripts/build.sh:**
```bash
#!/usr/bin/env bash
set -euo pipefail

SKIP_TESTS=false
for arg in "$@"; do
  case $arg in
    --skip-tests) SKIP_TESTS=true ;;
  esac
done

echo "==> Type checking..."
if [[ -f "tsconfig.json" ]]; then
  npx tsc --noEmit || { echo "Type check failed"; exit 1; }
fi

echo "==> Linting..."
npm run lint 2>/dev/null || bun run lint 2>/dev/null || true

if [[ "$SKIP_TESTS" == "true" ]]; then
  echo ""
  echo "=============================================="
  echo "  WARNING: Skipping tests is discouraged."
  echo "  Fix failing tests instead of bypassing them."
  echo "=============================================="
  echo ""
else
  echo "==> Running tests..."
  npm test || bun test || { echo "Tests failed"; exit 1; }
fi

echo "==> Building..."
npm run build || bun run build || { echo "Build failed"; exit 1; }

echo "==> Build complete"
```

**scripts/release.sh:**
```bash
#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
APPLY=false
SKIP_BUILD=false
SKIP_TESTS=false

for arg in "$@"; do
  case $arg in
    --apply|--confirm) APPLY=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --skip-tests) SKIP_TESTS=true ;;
  esac
done

die() { echo "ERROR: $1" >&2; exit 1; }

[[ -z "$VERSION" ]] && die "Usage: scripts/release.sh <version> [--apply]"

# Validate semver (with optional prerelease)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  die "Invalid version format: $VERSION (expected semver like 1.2.3 or 1.2.3-alpha.1)"
fi

# Pre-flight checks
echo "==> Pre-flight checks"
[[ -n "$(git status --porcelain)" ]] && die "Working tree not clean. Commit or stash changes first."

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" != "main" && "$BRANCH" != "master" && ! "$BRANCH" =~ ^release/ ]] && \
  echo "WARNING: Not on main branch (on $BRANCH)"

# Package info
PKG_NAME=$(jq -r '.name' package.json)
[[ -z "$PKG_NAME" || "$PKG_NAME" == "null" ]] && die "No package name in package.json"

# Check current published version
echo "==> Checking registry for $PKG_NAME"
CURRENT=$(npm view "$PKG_NAME" version 2>/dev/null || echo "0.0.0")
echo "   Current published: $CURRENT"
echo "   Target version:    $VERSION"

# Build
if [[ "$SKIP_BUILD" == "true" ]]; then
  echo ""
  echo "WARNING: Skipping build. Ensure artifacts are fresh."
  echo ""
else
  echo "==> Running build"
  BUILD_ARGS=""
  [[ "$SKIP_TESTS" == "true" ]] && BUILD_ARGS="--skip-tests"
  ./scripts/build.sh $BUILD_ARGS || die "Build failed"
fi

# Show what will be published
echo ""
echo "==> Package contents (dry-run):"
npm pack --dry-run 2>&1 | head -50

if [[ "$APPLY" != "true" ]]; then
  echo ""
  echo "================================================"
  echo "  DRY-RUN COMPLETE"
  echo "  "
  echo "  To actually publish, run:"
  echo "    scripts/release.sh $VERSION --apply"
  echo "================================================"
  exit 0
fi

# Update version in package.json
echo "==> Updating version to $VERSION"
npm version "$VERSION" --no-git-tag-version

# Get npm token from agents secrets
echo "==> Authenticating with npm"
NPM_TOKEN=$(agents secrets export npmjs.com --plaintext 2>/dev/null | grep NPM_TOKEN | cut -d= -f2-)
if [[ -z "$NPM_TOKEN" ]]; then
  die "No NPM_TOKEN found. Create it with: agents secrets create npmjs.com && agents secrets add npmjs.com NPM_TOKEN"
fi

# Write temporary .npmrc
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc.release
trap 'rm -f .npmrc.release' EXIT

# Publish
echo "==> Publishing to npm"
npm publish --access public --userconfig .npmrc.release || die "Publish failed"

# Verify publish
echo "==> Verifying publish"
sleep 2
PUBLISHED=$(npm view "$PKG_NAME@$VERSION" version 2>/dev/null || echo "")
if [[ "$PUBLISHED" != "$VERSION" ]]; then
  echo "WARNING: Could not verify $PKG_NAME@$VERSION on registry yet (may take a moment)"
fi

# Git operations AFTER successful publish
echo "==> Creating git tag"
git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -m "chore(release): $VERSION"
git tag "v$VERSION"
git push origin "$BRANCH"
git push origin "v$VERSION"

echo ""
echo "================================================"
echo "  RELEASED $PKG_NAME@$VERSION"
echo "  "
echo "  npm: https://www.npmjs.com/package/$PKG_NAME"
echo "  tag: v$VERSION"
echo "================================================"
```

### 2.3 Package hygiene

Check that the package doesn't publish unnecessary files:

```bash
# Check what would be published
npm pack --dry-run 2>&1

# Check for files field or .npmignore
jq '.files' package.json
cat .npmignore 2>/dev/null
```

If neither exists and `src/`, `tests/`, or large directories would be published, suggest creating `.npmignore`:

```
src/
tests/
*.test.ts
*.spec.ts
testdata/
.github/
.vscode/
*.log
.env*
```

---

## Phase 3: Version Analysis

### 3.1 Get current published version

```bash
PKG_NAME=$(jq -r '.name' package.json)

# npm registry
npm view "$PKG_NAME" version 2>/dev/null || echo "Not yet published"

# All published versions
npm view "$PKG_NAME" versions --json 2>/dev/null | jq -r '.[-5:][]'
```

### 3.2 Determine next version

If `$ARGUMENTS` contains `patch`, `minor`, or `major`:
- Calculate the next version from current published
- For prereleases: `1.2.3-alpha.1` → `1.2.3-alpha.2`

Semver rules:
- **Stable releases** (`1.2.3`): enforce single-step bumps only
  - `1.2.3` → `1.2.4` (patch) OK
  - `1.2.3` → `1.3.0` (minor) OK
  - `1.2.3` → `1.5.0` NOT OK (skips 1.4.0)
- **Prereleases** (`1.2.3-alpha.1`): allow free jumps within prerelease
  - `1.2.3-alpha.1` → `1.2.3-alpha.5` OK
  - `1.2.3-alpha.1` → `1.2.3-beta.1` OK
  - `1.2.3-rc.1` → `1.2.3` OK (promotion to stable)

### 3.3 Version validation

```bash
# Parse versions
CURRENT="1.2.3"
TARGET="1.2.4"

# Extract components
IFS='.-' read -r CMAJ CMIN CPAT CPRE <<< "$CURRENT"
IFS='.-' read -r TMAJ TMIN TPAT TPRE <<< "$TARGET"

# Validate (simplified)
if [[ -z "$TPRE" ]]; then
  # Stable release - must be single step
  # ... validation logic
fi
```

---

## Phase 4: Pre-flight Checks

### 4.1 Run tests (mandatory)

Even if the release script runs tests, run them first to fail fast:

```bash
npm test || bun test
```

If tests fail, this is a **blocking** issue. Do not proceed.

If `--skip-tests` was passed:
```
============================================
  WARNING: You are skipping tests.

  Skipping tests is strongly discouraged.
  It's better to fix failing tests than to
  ship broken code.

  Proceeding anyway because --skip-tests was set.
============================================
```

### 4.2 Check git state

```bash
# Must be clean
git status --porcelain

# Should be on main (warn if not)
git rev-parse --abbrev-ref HEAD
```

### 4.3 Check secrets

```bash
# List available secrets bundles
agents secrets list

# Check for npm token specifically
agents secrets export npmjs.com --plaintext 2>/dev/null | grep -q NPM_TOKEN && echo "npm auth: OK"
```

If required secrets are missing, this is **blocking**. Guide the user:
```
Missing npm authentication. Set it up with:
  agents secrets create npmjs.com
  agents secrets add npmjs.com NPM_TOKEN
```

### 4.4 Issue categorization

**Blocking (must fix before release):**
- Test failures
- Uncommitted changes in git
- Missing required secrets
- Version already published (unless `--force`)
- Invalid semver format

**Non-blocking (warn and continue):**
- Not on main branch
- Using `--skip-tests` or `--skip-build`
- No CHANGELOG.md (will create one)
- No dry-run mode in release script

---

## Phase 5: Changelog

> **Fragment model (preferred).** If the repo has a `.changelog/` directory (the
> `code:changelog` skill / towncrier-style fragments), the changelog is a
> GENERATED artifact: per-PR notes live in `.changelog/next/<ticket>.md`, and the
> release script folds them into `.changelog/<version>.md` and regenerates
> `CHANGELOG.md`. **Skip 5.3–5.4** — the release script owns the changelog; just
> confirm the queue is non-empty (`ls .changelog/next/*.md`) so the release can
> document itself. Sections 5.1–5.4 below are the legacy single-file path for
> repos without `.changelog/`.

### 5.1 Get commits since last release

```bash
# Find last release tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [[ -n "$LAST_TAG" ]]; then
  echo "Commits since $LAST_TAG:"
  git log "$LAST_TAG"..HEAD --oneline --no-merges
else
  echo "No previous tags. Showing recent commits:"
  git log -20 --oneline --no-merges
fi
```

### 5.2 Parse conventional commits

Group commits by type:

```bash
git log "$LAST_TAG"..HEAD --oneline --no-merges | while read -r line; do
  if [[ "$line" =~ ^[a-f0-9]+\ feat ]]; then
    echo "ADDED: $line"
  elif [[ "$line" =~ ^[a-f0-9]+\ fix ]]; then
    echo "FIXED: $line"
  elif [[ "$line" =~ ^[a-f0-9]+\ (refactor|perf|chore) ]]; then
    echo "CHANGED: $line"
  fi
done
```

### 5.3 Generate changelog entry

Format:
```markdown
## [1.2.3] - 2026-05-09

### Added
- feat(auth): OAuth refresh token support (#123)

### Fixed  
- fix(sync): orphan sweep for stale resources (#124)

### Changed
- refactor(runner): simplify job execution
```

### 5.4 Update or create CHANGELOG.md

If CHANGELOG.md exists, prepend the new section after the header.
If it doesn't exist, create it:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [1.2.3] - 2026-05-09

### Added
...
```

---

## Phase 6: Execute Release

### 6.1 Dry-run first

If the release script supports dry-run:
```bash
./scripts/release.sh "$VERSION"
```

Show the output and summarize what will happen.

### 6.2 Confirm with user

Before actual release, use `AskUserQuestion`:
- Show version change: `1.2.2 → 1.2.3`
- Show registry target
- Show changelog entry preview
- Show files that will be published

Options: "Release now", "Edit changelog first", "Cancel"

### 6.3 Execute

```bash
./scripts/release.sh "$VERSION" --apply
```

### 6.4 Verify

After the script completes:
```bash
# Verify on npm
npm view "$PKG_NAME@$VERSION" version

# Verify tag exists
git tag -l "v$VERSION"
```

### 6.5 Report success

```
Released @phnx-labs/agents-cli@1.2.3

- npm: https://www.npmjs.com/package/@phnx-labs/agents-cli
- tag: v1.2.3
- changelog: Updated CHANGELOG.md
```

---

## Escape Hatches

These flags exist but their use is discouraged:

| Flag | Effect | When shown |
|------|--------|-----------|
| `--skip-tests` | Skip test suite | Prints warning about fixing tests being better |
| `--skip-build` | Skip build step | Warns about stale artifacts |
| `--force` | Skip version validation | Warns about registry conflicts |

Always show warnings when these are used. Never silently skip.

---

## Error Handling

### Tests fail
```
Tests failed. Fix the failing tests before releasing.

Failing tests:
  - src/lib/runner.test.ts: timeout handling
  - src/lib/events.test.ts: rotation logic

Run `npm test` to see full output.
```

### Version already published
```
Version 1.2.3 is already published on npm.

Options:
1. Bump to 1.2.4: scripts/release.sh 1.2.4 --apply
2. Use prerelease: scripts/release.sh 1.2.4-beta.1 --apply
3. Force republish (dangerous): scripts/release.sh 1.2.3 --force --apply
```

### Missing secrets
```
npm authentication not configured.

Set up npm token:
  1. Go to https://www.npmjs.com/settings/tokens
  2. Create an "Automation" token with publish access
  3. Save it:
     agents secrets create npmjs.com
     agents secrets add npmjs.com NPM_TOKEN
```
