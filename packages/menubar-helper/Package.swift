// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MenubarHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "MenubarHelper",
            path: "Sources/MenubarHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
                .linkedLibrary("sqlite3"),
            ]
        )
    ]
)
