// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComputerHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ComputerHelper",
            path: "Sources/ComputerHelper",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        )
    ]
)
