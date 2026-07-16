# Fleet Cockpit (iOS / iPadOS)

Native companion app for the agents fleet. **iOS is a control plane, not a compute
worker** (Apple disables the hypervisor on iPadOS and grants JIT to browsers only, so no
Node harness runs on-device). The app dispatches, streams, and steers agents that run on
the fleet via the authenticated `agents serve --control` **anchor**.

```
iPhone/iPad  ──HTTPS+SSE over the tailnet──►  anchor (agents serve --control)  ──►  executors
 (this app)      bearer token, per device        holds SSH keys, runs the CLI     (worker / cloud)
```

## Layout

| Path | What | Build |
|---|---|---|
| `AnchorKit/` | SwiftPM library: models, SSE parser, `AnchorClient`, Keychain token store. The load-bearing logic. | `swift build` / verified headlessly (below) |
| `Cockpit/` | SwiftUI app (Fleet · Dispatch · Session · Settings) — a thin projection of AnchorKit. | **requires full Xcode** |

## AnchorKit is verified without Xcode

`XCTest`/`swift-testing` ship only with full Xcode, and this repo's CI is Node/bun, so
AnchorKit ships two runnable verifiers instead:

```bash
cd apps/ios/AnchorKit
swift run anchorcheck                       # pure-logic assertions (SSE, model coding, token store)
# live end-to-end against a REAL anchor:
ANCHOR_URL=http://127.0.0.1:4477 ANCHOR_TOKEN=<token> ANCHOR_SESSION=<id> swift run anchorprobe
```

`anchorprobe` was run against a live `agents serve --control` server: `fetchState` decodes,
a bad token returns `401`, and the SSE stream yields events with byte-offset resume ids and
terminal detection. See the PR for the transcript.

## Building the app (needs Xcode)

The `Cockpit/` SwiftUI target requires full Xcode (SwiftUI app bundle + simulator/device),
which the CI-only environment this was authored in does not have — so the **app target is
source-complete but not compiled here**. On a machine with Xcode: create an iOS App target,
add the `AnchorKit` package as a local dependency, and add the `Cockpit/*.swift` sources.
The app consumes only AnchorKit's verified API surface.

## Pairing

On the anchor: `agents devices pair-ios <name>` mints a control token (shown once) and marks
the device control-only. Enter the anchor URL + token in the app's Settings. Keep the control
server on the tailnet — never public Funnel.
