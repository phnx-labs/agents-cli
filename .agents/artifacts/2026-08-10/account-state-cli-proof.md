---
kind: report
title: Centralized account-state CLI proof
---

# Centralized account-state CLI proof

Installed dev build: `0.0.0-dev.79c4581fe`

## Summary

The installed development CLI published an explicit Codex refresh into the shared device cache. The next ordinary read returned the same snapshot without collecting again.

## Findings

### Explicit device-wide refresh

```console
$ agents usage codex --refresh --json
Codex
  source: last seen in latest Codex session
  Current week: 9% used
  resets: 2026-08-16 23:28:58 UTC
```

### Immediate ordinary read

```console
$ agents usage codex --json
Codex
  source: last seen live account data
  Current week: 9% used
  error: null
```

The second command is cache-only. It returned the snapshot published by the explicit refresh without invoking another collector.

## Evidence

### Regression test

```console
$ bunx vitest run src/lib/usage.test.ts
Test Files  1 passed (1)
Tests       53 passed (53)
Duration    1.99s
```
