import SwiftUI
import AnchorKit

// Fleet Cockpit — iOS/iPadOS companion for the agents fleet (RUSH-1734).
//
// The app is a thin projection of AnchorKit (built + verified separately): every
// network effect goes through AppModel → AnchorClient. iOS is a control plane,
// never a compute worker — this app dispatches, streams, and steers agents that
// run on the fleet via `agents serve --control`.
//
// NOTE: this app target requires full Xcode to build (SwiftUI app bundle +
// simulator). AnchorKit — the load-bearing logic — is built and tested
// headlessly and verified live against a real anchor; see apps/ios/README.md.

@main
struct CockpitApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model)
        }
    }
}

/// Single source of truth for the app: anchor config + the AnchorKit client.
@MainActor
final class AppModel: ObservableObject {
    @Published var anchorURL: String
    @Published var isPaired: Bool
    @Published var lastError: String?

    private let tokens: TokenStore
    private static let urlKey = "cockpit.anchorURL"

    init(tokens: TokenStore = defaultTokenStore()) {
        self.tokens = tokens
        self.anchorURL = UserDefaults.standard.string(forKey: Self.urlKey) ?? ""
        self.isPaired = (tokens.load() != nil) && !(UserDefaults.standard.string(forKey: Self.urlKey) ?? "").isEmpty
    }

    private static func defaultTokenStore() -> TokenStore {
        #if canImport(Security)
        return KeychainTokenStore()
        #else
        return InMemoryTokenStore()
        #endif
    }

    /// Build a client from the stored config, or nil when unpaired.
    func client() -> AnchorClient? {
        guard let token = tokens.load(), let url = URL(string: anchorURL) else { return nil }
        return AnchorClient(baseURL: url, token: token)
    }

    /// Save pairing (anchor URL + token from `agents devices pair-ios`).
    func pair(url: String, token: String) throws {
        try tokens.save(token)
        UserDefaults.standard.set(url, forKey: Self.urlKey)
        anchorURL = url
        isPaired = !token.isEmpty && !url.isEmpty
    }

    func unpair() {
        try? tokens.clear()
        UserDefaults.standard.removeObject(forKey: Self.urlKey)
        isPaired = false
    }

    func report(_ error: Error) { lastError = "\(error)" }
}
