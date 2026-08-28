import Foundation

// Device-favorites self-test (PHNX-2376): decode the `preferred` flag off a real
// `menubar snapshot --json` devices payload and exercise the pure ordering
// (`StatusItemController.planDeviceRows`) that puts this Mac first, favorited
// (auto-launch.preferred) devices with a ★ next, then the rest, with a divider
// between favorites and the rest. Gated by MENUBAR_DEVICE_TEST=1 (main.swift); no
// GUI, no Accessibility grant. Mirrors LoadedDeviceSelfTest / RoutineSelfTest.
enum DeviceSelfTest {
    // Compact readout of a plan: device names get a leading ★ when preferred and a
    // trailing * when local; a divider is `|`.
    private static func describe(_ plan: [StatusItemController.DeviceRowEntry]) -> [String] {
        plan.map { entry in
            switch entry {
            case .divider: return "|"
            case .device(let d):
                return "\(d.isPreferred ? "★" : "")\(d.name)\(d.isLocal ? "*" : "")"
            }
        }
    }

    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL") — \(name)")
            if !cond { pass = false }
        }

        // 1. An older snapshot with NO `preferred` field still decodes, reading as
        //    not-favorited (version skew between the helper and the on-PATH CLI).
        let legacyJSON = #"{"name":"box","platform":"linux","interactive":false,"isLocal":false}"#
        let legacy = try? JSONDecoder().decode(Device.self, from: Data(legacyJSON.utf8))
        check("device with no `preferred` field decodes", legacy != nil)
        check("missing `preferred` reads as not favorited", legacy?.isPreferred == false)

        // 2. The `preferred` flag decodes off the real snapshot shape.
        let payload = #"""
        [
          {"name":"zion","platform":"macos","interactive":true,"isLocal":true,"preferred":false},
          {"name":"yosemite-m2","platform":"linux","interactive":false,"isLocal":false,"preferred":true},
          {"name":"mac-mini","platform":"macos","interactive":false,"isLocal":false,"preferred":false},
          {"name":"ci-runner","platform":"linux","interactive":false,"isLocal":false,"preferred":true},
          {"name":"win-mini","platform":"windows","interactive":false,"isLocal":false,"preferred":false}
        ]
        """#
        guard let devices = try? JSONDecoder().decode([Device].self, from: Data(payload.utf8)) else {
            print("FAIL — devices payload decode")
            print("SOME FAILED")
            exit(1)
        }
        check("preferred flag decodes true", devices.first { $0.name == "ci-runner" }?.isPreferred == true)
        check("preferred flag decodes false", devices.first { $0.name == "mac-mini" }?.isPreferred == false)

        // 3. Order: this Mac first, favorites (alpha) next, divider, then the rest (alpha).
        let plan = StatusItemController.planDeviceRows(devices)
        check("ordered: this Mac, favorites, |, rest",
              describe(plan) == ["zion*", "★ci-runner", "★yosemite-m2", "|", "mac-mini", "win-mini"])
        check("this Mac is always the first row", {
            if case .device(let d) = plan.first { return d.isLocal }
            return false
        }())

        // 4. No favorites → order unchanged from a flat list, and NO divider.
        let noneFav = devices.map {
            Device(name: $0.name, platform: $0.platform, interactive: $0.interactive,
                   isLocal: $0.isLocal, preferred: false)
        }
        let flatPlan = StatusItemController.planDeviceRows(noneFav)
        check("no favorites → no divider", !flatPlan.contains(.divider))
        check("no favorites → this Mac first then alphabetical",
              describe(flatPlan) == ["zion*", "ci-runner", "mac-mini", "win-mini", "yosemite-m2"])

        // 5. All non-local devices favorited → still no dangling divider (empty rest).
        let allFav = devices.map {
            Device(name: $0.name, platform: $0.platform, interactive: $0.interactive,
                   isLocal: $0.isLocal, preferred: !$0.isLocal)
        }
        let allFavPlan = StatusItemController.planDeviceRows(allFav)
        check("all favorited → no dangling divider", !allFavPlan.contains(.divider))

        // 6. A preferred LOCAL device is still first, with its ★, and does not by
        //    itself force a divider when there are no non-local favorites.
        let localFav = [
            Device(name: "zion", platform: "macos", interactive: true, isLocal: true, preferred: true),
            Device(name: "mac-mini", platform: "macos", interactive: false, isLocal: false, preferred: false),
        ]
        check("preferred local Mac is first with ★, no divider",
              describe(StatusItemController.planDeviceRows(localFav)) == ["★zion*", "mac-mini"])

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
