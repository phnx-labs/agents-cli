import SwiftUI
import AnchorKit

/// Tab shell: Fleet, Dispatch, Settings. Gates on pairing.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if model.isPaired {
            TabView {
                NavigationStack { FleetView() }
                    .tabItem { Label("Fleet", systemImage: "square.grid.2x2") }
                NavigationStack { DispatchView() }
                    .tabItem { Label("Dispatch", systemImage: "paperplane") }
                NavigationStack { SettingsView() }
                    .tabItem { Label("Settings", systemImage: "gearshape") }
            }
        } else {
            NavigationStack { SettingsView() }
        }
    }
}

/// Fleet health from `GET /api/state`.
struct FleetView: View {
    @EnvironmentObject var model: AppModel
    @State private var state: FleetState?
    @State private var error: String?

    var body: some View {
        List {
            if let s = state {
                Section("Snapshot") { Text("Updated \(s.generatedAt)").font(.footnote).foregroundStyle(.secondary) }
                Section("Panels") {
                    row("Teams", s.teamsOK)
                    row("Routines", s.routinesOK)
                    row("Cloud", s.cloudOK)
                }
            } else if let error {
                Text(error).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Fleet")
        .refreshable { await load() }
        .task { await load() }
    }

    private func row(_ label: String, _ ok: Bool) -> some View {
        HStack {
            Text(label)
            Spacer()
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(ok ? .green : .orange)
        }
    }

    private func load() async {
        guard let client = model.client() else { return }
        do { state = try await client.fetchState(); error = nil }
        catch { self.error = "\(error)" }
    }
}

/// Dispatch a headless run, then stream it.
struct DispatchView: View {
    @EnvironmentObject var model: AppModel
    @State private var agent = "claude"
    @State private var prompt = ""
    @State private var mode = "plan"
    @State private var host = ""
    @State private var started: String?

    private let agents = ["claude", "codex", "gemini"]
    private let modes = ["plan", "edit", "auto", "skip"]

    var body: some View {
        Form {
            Section("Agent") {
                Picker("Agent", selection: $agent) { ForEach(agents, id: \.self, content: Text.init) }
                Picker("Mode", selection: $mode) { ForEach(modes, id: \.self, content: Text.init) }
                TextField("Executor host (blank = anchor)", text: $host).autocorrectionDisabled()
            }
            Section("Prompt") {
                TextField("What should it do?", text: $prompt, axis: .vertical).lineLimit(3...8)
            }
            Section {
                Button("Dispatch") { Task { await dispatch() } }
                    .disabled(prompt.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let started {
                NavigationLink("Watch \(started)") { SessionView(sessionId: started) }
            }
        }
        .navigationTitle("Dispatch")
    }

    private func dispatch() async {
        guard let client = model.client() else { return }
        let req = RunRequest(agent: agent, prompt: prompt, mode: mode,
                             host: host.isEmpty ? nil : host)
        do { started = try await client.dispatchRun(req).sessionId }
        catch { model.report(error) }
    }
}

/// Live transcript of a run via the SSE stream, with a steer field.
struct SessionView: View {
    @EnvironmentObject var model: AppModel
    let sessionId: String
    @State private var events: [StreamEvent] = []
    @State private var steer = ""
    @State private var streamTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            List(Array(events.enumerated()), id: \.offset) { _, ev in
                VStack(alignment: .leading, spacing: 2) {
                    Text(ev.type).font(.caption.monospaced()).foregroundStyle(.secondary)
                    Text(ev.data).font(.callout.monospaced()).lineLimit(6)
                }
            }
            HStack {
                TextField("Steer the agent…", text: $steer)
                Button("Send") { Task { await send() } }
                    .disabled(steer.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
        }
        .navigationTitle(sessionId)
        .task { start() }
        .onDisappear { streamTask?.cancel() }
    }

    private func start() {
        guard let client = model.client() else { return }
        streamTask = Task {
            do { for try await ev in client.events(sessionId: sessionId) { events.append(ev) } }
            catch { model.report(error) }
        }
    }

    private func send() async {
        guard let client = model.client() else { return }
        let text = steer; steer = ""
        do { try await client.sendMessage(sessionId: sessionId, text: text, from: "cockpit") }
        catch { model.report(error) }
    }
}

/// Pairing: anchor URL + token from `agents devices pair-ios`.
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var url = ""
    @State private var token = ""

    var body: some View {
        Form {
            Section("Anchor") {
                TextField("http://<anchor-tailnet-ip>:4477", text: $url)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                SecureField("Control token", text: $token)
            }
            Section {
                Button(model.isPaired ? "Update pairing" : "Pair") {
                    do { try model.pair(url: url, token: token); token = "" }
                    catch { model.report(error) }
                }.disabled(url.isEmpty || token.isEmpty)
                if model.isPaired { Button("Unpair", role: .destructive) { model.unpair() } }
            } footer: {
                Text("Run `agents devices pair-ios` on the anchor to mint a token. Keep the anchor on your tailnet.")
            }
            if let err = model.lastError {
                Section("Last error") { Text(err).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Settings")
        .onAppear { url = model.anchorURL }
    }
}
