import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Typed client for the authenticated `agents serve --control` anchor.
///
/// Every request carries the paired bearer token. The four operations mirror the
/// server surface: read fleet state, dispatch a run, steer a run, and tail a
/// run's live events. All networking lives here so the SwiftUI layer stays a
/// thin projection of `AnchorKit` — and so this can be exercised end to end
/// against a real anchor from `anchorprobe` and the tests.
public struct AnchorClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    private func request(_ path: String, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    private func check(_ response: URLResponse, _ body: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw AnchorError.unauthorized }
            let msg = (try? JSONDecoder().decode([String: String].self, from: body))?["error"]
            throw AnchorError.http(status: http.statusCode, message: msg)
        }
    }

    /// `GET /api/state` — the fleet snapshot backing the Fleet view.
    public func fetchState() async throws -> FleetState {
        let (data, response) = try await session.data(for: request("api/state"))
        try check(response, data)
        do { return try JSONDecoder().decode(FleetState.self, from: data) }
        catch { throw AnchorError.decoding("\(error)") }
    }

    /// `POST /api/run` — dispatch a headless run; returns its addressable ids.
    public func dispatchRun(_ run: RunRequest) async throws -> RunResult {
        var req = request("api/run", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(run)
        let (data, response) = try await session.data(for: req)
        try check(response, data)
        do { return try JSONDecoder().decode(RunResult.self, from: data) }
        catch { throw AnchorError.decoding("\(error)") }
    }

    /// `POST /api/session/:id/message` — steer a running/parked agent.
    public func sendMessage(sessionId: String, text: String, from: String? = nil) async throws {
        var req = request("api/session/\(encode(sessionId))/message", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["text": text]
        if let from { body["from"] = from }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: req)
        try check(response, data)
    }

    /// `GET /api/session/:id/stream` — the live SSE event stream, resumable from
    /// `fromOffset`. Yields normalized events until the terminal `end` frame or
    /// the task is cancelled.
    public func events(sessionId: String, fromOffset: Int? = nil) -> AsyncThrowingStream<StreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var path = "api/session/\(encode(sessionId))/stream"
                    if let fromOffset { path += "?offset=\(fromOffset)" }
                    let (bytes, response) = try await session.bytes(for: request(path))
                    if let http = response as? HTTPURLResponse, http.statusCode == 401 {
                        throw AnchorError.unauthorized
                    }
                    // Split the raw byte stream on \n ourselves — `bytes.lines`
                    // does not reliably surface the BLANK lines that terminate
                    // SSE frames, so the parser would never close a frame.
                    var parser = SSEParser()
                    var buf: [UInt8] = []
                    for try await byte in bytes {
                        if byte == 0x0A { // \n
                            let line = String(decoding: buf, as: UTF8.self)
                            buf.removeAll(keepingCapacity: true)
                            if let ev = parser.feed(line) {
                                continuation.yield(ev)
                                if ev.type == "end" { continuation.finish(); return }
                            }
                        } else if byte != 0x0D { // drop \r; feed() also tolerates it
                            buf.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func encode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}
