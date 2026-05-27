---
name: scripts
description: "Scripts directory contract — canonical build/test/install/release.sh patterns for deployable projects. Triggers on: scripts/, release.sh, build.sh, deploy, publish."
user-invocable: false
---

# Scripts Directory Contract

Every deployable project keeps a `scripts/` directory with a small set of canonical scripts. Use them. Don't reinvent.

## Canonical scripts

- `scripts/build.sh` — compile/bundle and **run the test suite**. Green build means tests passed.
- `scripts/test.sh` — full test suite, runnable on its own.
- `scripts/install.sh` — install dependencies, set up local config.
- `scripts/release.sh` — ship the artifact (npm publish, docker push, deploy, etc.). **Use `release` as the canonical name** — covers all forms of shipping.

## release.sh contract

- **Defaults to dry-run.** Without `--confirm`, the script prints exactly what it would do and exits 0. Nothing mutates.
- **`--confirm` is required to actually release.** No other flag substitutes.
- **`--skip-build` and `--skip-tests`** are escape hatches for re-runs after a verified-elsewhere build, or hotfixes. Default: run both.
- **Refuses on test failure** unless `--skip-tests` was explicitly passed. If you find yourself adding `|| true` to silence a check, stop.
- **Pre-flight checks run before slow checks.** Version-collision (`npm view <pkg> versions --json` against `package.json`) before `bun test`. Missing-secrets check before `git push`. Cheap failures fast.
- **Source of truth is the system the script targets, not git.** npm publish status comes from the registry, not commit subjects. Deploy status comes from the deploy registry.
- **Idempotent.** If `release.sh` is interrupted between version-bump and the actual publish, re-running converges — no double-bump, no double-tag.

## What "done" means for a release

A release isn't done until the package version shows up on the registry (or the deploy URL serves the new build). Code merged is not released.

## Anti-patterns

- `release.sh` that publishes without running tests by default.
- Detecting "what's already published" by `git log` subject lines instead of the registry.
- Running expensive checks (test suites, builds) before cheap checks (version collision, missing secrets).
- A `deploy.sh` with no dry-run mode that hits production on every invocation.
