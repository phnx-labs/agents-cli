# apps/ios — Fleet Cockpit

iOS/iPadOS companion for the agents fleet. See the root [AGENTS.md](../../AGENTS.md) for
repo-wide policy; this file is the app's contracts. Usage/build detail: [README.md](README.md).

## Contracts

- **A control plane, never a compute worker.** No agent runs on-device — iPadOS disables
  the hypervisor and grants JIT to browsers only. Every action is a call to the anchor
  (`agents serve --control`) over HTTPS+SSE on the tailnet; executors run on worker/cloud.
  Do not add on-device agent execution.
- **`AnchorKit/` is the load-bearing, verified surface** (`Sources/AnchorKit/`:
  `AnchorClient.swift`, `SSEParser.swift`, `TokenStore.swift`, `Models.swift`). **`Cockpit/`
  (SwiftUI) consumes only AnchorKit's public API** and is compiled only under full Xcode —
  it is source-complete but NOT built in CI (CI is Node/bun, no XCTest). Put logic in
  AnchorKit, not Cockpit, so it stays verifiable.
- **Auth is a per-device bearer token in the Keychain** — `KeychainTokenStore`
  (`TokenStore.swift:27`); tests use `InMemoryTokenStore` (`TokenStore.swift:15`). A bad
  token gets a 401 — asserted live in `Sources/anchorprobe/main.swift:39`
  (`token: "definitely-wrong"` → error).
- **Keep the control server on the tailnet — never public Funnel.** The token is the only
  gate; do not expose the anchor publicly.

## Verify without Xcode

`XCTest`/`swift-testing` need full Xcode, so AnchorKit ships two runnable verifiers
instead of a test target:

```bash
cd apps/ios/AnchorKit
swift run anchorcheck    # pure-logic assertions: SSE parse, model coding, token store (Sources/anchorcheck/main.swift)
# live, against a real anchor:
ANCHOR_URL=http://127.0.0.1:4477 ANCHOR_TOKEN=<token> ANCHOR_SESSION=<id> swift run anchorprobe
```

Any change to AnchorKit must keep `anchorcheck` green; a change to the client/SSE path
should be exercised with `anchorprobe` against a live `agents serve --control`.

## Pairing

On the anchor: `agents devices pair-ios <name>` mints a control token (shown once) and
marks the device control-only. Enter the anchor URL + token in the app's Settings.
