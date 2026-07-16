import Foundation

/// Incremental parser for the anchor's Server-Sent Events stream.
///
/// Frames are `id:` / `event:` / `data:` lines terminated by a blank line. The
/// parser accumulates fields line-by-line and emits a ``StreamEvent`` when the
/// frame closes. It mirrors the server contract in `serve/control.ts`
/// (`startSessionStream`): one event per frame, `id` = the byte-offset resume
/// cursor. Unknown fields and comment lines (`:` prefix) are ignored per the SSE
/// spec.
public struct SSEParser {
    private var id: Int?
    private var event: String?
    private var data: String?

    public init() {}

    /// Feed one line (without its trailing newline). Returns a ``StreamEvent``
    /// when this line closes a frame (a blank line), otherwise `nil`.
    public mutating func feed(_ rawLine: String) -> StreamEvent? {
        // Strip a single trailing CR (CRLF streams).
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine

        if line.isEmpty {
            // Blank line terminates the frame. A frame with no `event:` and no
            // `data:` (a keep-alive) yields nothing.
            defer { id = nil; event = nil; data = nil }
            guard event != nil || data != nil else { return nil }
            return StreamEvent(id: id, type: event ?? "message", data: data ?? "")
        }
        if line.hasPrefix(":") { return nil } // comment / heartbeat

        guard let colon = line.firstIndex(of: ":") else { return nil }
        let field = String(line[line.startIndex..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() } // SSE strips one leading space

        switch field {
        case "id": id = Int(value)
        case "event": event = value
        case "data": data = data.map { $0 + "\n" + value } ?? value
        default: break // ignore unknown fields (e.g. `retry`)
        }
        return nil
    }

    /// Parse a complete SSE text blob into events (convenience for tests).
    public static func parse(_ text: String) -> [StreamEvent] {
        var parser = SSEParser()
        var out: [StreamEvent] = []
        // Split on \n; feed() handles a trailing \r. A final frame without a
        // trailing blank line is flushed explicitly below.
        for line in text.components(separatedBy: "\n") {
            if let ev = parser.feed(line) { out.append(ev) }
        }
        if let ev = parser.feed("") { out.append(ev) } // flush any dangling frame
        return out
    }
}
