import Foundation

/// A request to start an agent run on the anchor — the body of `POST /api/run`.
public struct RunRequest: Codable, Equatable, Sendable {
    public var agent: String
    public var prompt: String
    public var mode: String?
    public var host: String?
    public var cwd: String?

    public init(agent: String, prompt: String, mode: String? = nil, host: String? = nil, cwd: String? = nil) {
        self.agent = agent
        self.prompt = prompt
        self.mode = mode
        self.host = host
        self.cwd = cwd
    }
}

/// The anchor's `POST /api/run` response: the ids by which the run can be
/// streamed and steered.
public struct RunResult: Codable, Equatable, Sendable {
    public let sessionId: String
    public let name: String
}

/// A normalized live event decoded from the SSE stream at
/// `GET /api/session/:id/stream`.
public struct StreamEvent: Equatable, Sendable {
    /// The SSE `id:` — the exact byte offset past this event's line, used as the
    /// resume cursor (`Last-Event-ID` / `?offset=`). `nil` for control frames
    /// like the terminal `end`.
    public let id: Int?
    /// The SSE `event:` — `assistant`, `tool_use`, `result`, `error`, `end`, …
    public let type: String
    /// The raw JSON payload from the `data:` line.
    public let data: String

    public init(id: Int?, type: String, data: String) {
        self.id = id
        self.type = type
        self.data = data
    }

    /// True for the frames that end a run's stream.
    public var isTerminal: Bool { type == "end" || type == "result" || type == "error" }
}

/// A lightweight decode of the anchor's `GET /api/state` snapshot. Enough to
/// drive the Fleet view's health at a glance; the full panels are decoded by the
/// UI as needed.
public struct FleetState: Decodable, Equatable, Sendable {
    public let generatedAt: String
    public let teamsOK: Bool
    public let routinesOK: Bool
    public let cloudOK: Bool

    private struct Panel: Decodable { let ok: Bool }

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case teams, routines, cloud
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        teamsOK = (try? c.decode(Panel.self, forKey: .teams))?.ok ?? false
        routinesOK = (try? c.decode(Panel.self, forKey: .routines))?.ok ?? false
        cloudOK = (try? c.decode(Panel.self, forKey: .cloud))?.ok ?? false
    }
}

/// Errors surfaced by ``AnchorClient``.
public enum AnchorError: Error, Equatable, Sendable {
    /// Non-2xx HTTP status, with the server-provided message when present.
    case http(status: Int, message: String?)
    /// The bearer token was rejected (401).
    case unauthorized
    /// A response body could not be decoded.
    case decoding(String)
    /// A malformed base URL / request.
    case badRequest(String)
}
