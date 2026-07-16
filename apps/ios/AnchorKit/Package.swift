// swift-tools-version:5.9
import PackageDescription

// AnchorKit — the verified networking core of the Fleet Cockpit iOS/iPadOS app.
//
// The client logic (models, SSE parsing, the anchor API client, token storage)
// lives here as a platform-agnostic SwiftPM library so it can be built and
// verified headlessly on macOS — no Xcode or simulator required — and reused
// verbatim by the SwiftUI app target.
//
// Verification uses two runnable executables rather than XCTest/swift-testing,
// because those frameworks ship only with full Xcode (this repo's CI is
// Node/bun and never builds Swift; a dev machine with Xcode can add XCTest
// targets later):
//   • `anchorcheck` — pure-logic assertions (SSE parsing, model coding, token
//     store). `swift run anchorcheck` exits non-zero on any failure.
//   • `anchorprobe` — drives AnchorClient against a REAL `agents serve
//     --control` anchor end to end.
let package = Package(
    name: "AnchorKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "AnchorKit", targets: ["AnchorKit"]),
        .executable(name: "anchorprobe", targets: ["anchorprobe"]),
        .executable(name: "anchorcheck", targets: ["anchorcheck"]),
    ],
    targets: [
        .target(name: "AnchorKit"),
        .executableTarget(name: "anchorprobe", dependencies: ["AnchorKit"]),
        .executableTarget(name: "anchorcheck", dependencies: ["AnchorKit"]),
    ]
)
