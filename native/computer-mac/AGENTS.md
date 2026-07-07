# computer-helper (macOS)

macOS backend for `agents computer` — Swift daemon exposing Accessibility (AX) +
ScreenCaptureKit + CoreGraphics event injection over line-delimited JSON-RPC on a
Unix domain socket. Windows sibling: [`native/computer-win`](../computer-win).

This file is a **map**. [README.md](README.md) is the deep reference (permissions,
peer-auth, `.app`-bundle rationale, protocol) — read it before editing.

## Layout

```
Sources/ComputerHelper/RPC.swift   Canonical method list + dispatch
Sources/ComputerHelper/*.swift     AX walk, screenshot, event injection, policy, peer-auth
scripts/build.sh                   Build (debug single-arch / release universal)
Package.swift                      SwiftPM manifest
```

## Build

```bash
./scripts/build.sh          # debug (single-arch)
./scripts/build.sh release  # universal arm64 + x86_64
```

Outputs `dist/computer-helper-mac` (bare binary) and `dist/ComputerHelper.app`
(signed bundle, id `com.phnx-labs.computer-helper`). The `.app` form gives a stable
TCC identity that survives across launches — a bare binary inherits TCC identity
from its launcher and loses grants (see README §"Why a .app bundle").

## How the CLI reaches it

`apps/cli/src/lib/computer-rpc.ts` — `resolveHelperExec()` looks for
`native/computer-mac/dist/ComputerHelper.app/Contents/MacOS/ComputerHelper` (dev
checkout, 4 hops up from `apps/cli/dist/lib`) or the bundled npm copy. The daemon
runs under launchd on a Unix socket; the CLI connects locally (no tunnel).

## Security model (see README for full detail)

- **Default-deny allow list** — every action checks the target's bundle id against
  `Computer(<bundle-id>)` rules in `~/.agents/permissions/groups/`. `agents computer
  reload` pushes changes via SIGHUP.
- **Hard floor** — `com.apple.tccd`, `com.apple.SecurityAgent`,
  `com.apple.systempreferences` are denied unconditionally (TCC escalation paths).
- **Peer-auth** — connecting callers are verified by exec path against
  `computer-peers.json`; fail-safe-empty denies everything if the policy is missing.
