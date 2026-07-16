import Foundation
import AnchorKit

// anchorcheck — headless verification of AnchorKit's pure logic (no XCTest, which
// needs full Xcode). `swift run anchorcheck` runs every assertion and exits
// non-zero on the first failure, printing one line per check.

var failures = 0
func check(_ name: String, _ cond: Bool) {
    print("\(cond ? "ok  " : "FAIL") \(name)")
    if !cond { failures += 1 }
}

// --- SSE parsing ---
do {
    let blob = """
    id: 35
    event: system
    data: {"type":"system"}

    id: 83
    event: assistant
    data: {"type":"assistant","t":"hi"}

    event: end
    data: {"ok":true}

    """
    let e = SSEParser.parse(blob)
    check("sse: three frames parsed", e.count == 3)
    check("sse: first id/type/data", e[0].id == 35 && e[0].type == "system" && e[0].data == #"{"type":"system"}"#)
    check("sse: assistant frame", e[1].id == 83 && e[1].type == "assistant")
    check("sse: end frame terminal, no id", e[2].type == "end" && e[2].id == nil && e[2].isTerminal)

    let hb = SSEParser.parse(": keep-alive\nretry: 1000\nevent: result\ndata: {}\n\n")
    check("sse: ignores comments/unknown fields", hb.count == 1 && hb[0].type == "result" && hb[0].isTerminal)

    var p = SSEParser()
    _ = p.feed("event: assistant\r"); _ = p.feed("data:  two\r")
    let ev = p.feed("")
    check("sse: strips one leading space + trailing CR", ev?.type == "assistant" && ev?.data == " two")

    check("sse: concatenates multiple data lines", SSEParser.parse("event: x\ndata: a\ndata: b\n\n").first?.data == "a\nb")
}

// --- model coding ---
do {
    let data = try JSONEncoder().encode(RunRequest(agent: "claude", prompt: "go"))
    let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    check("model: RunRequest keeps agent/prompt", obj["agent"] as? String == "claude" && obj["prompt"] as? String == "go")
    check("model: RunRequest omits nil optionals", obj["mode"] == nil && obj["host"] == nil && obj["cwd"] == nil)

    let r = try JSONDecoder().decode(RunResult.self, from: Data(#"{"sessionId":"sid","name":"ios-ab"}"#.utf8))
    check("model: RunResult decodes", r.sessionId == "sid" && r.name == "ios-ab")

    let s = try JSONDecoder().decode(FleetState.self, from: Data(#"""
    {"generated_at":"2026-07-16T00:00:00Z","teams":{"ok":true,"data":[]},"routines":{"ok":true,"data":[]},"cloud":{"ok":false,"error":"x"}}
    """#.utf8))
    check("model: FleetState decodes generated_at + panel ok", s.generatedAt == "2026-07-16T00:00:00Z" && s.teamsOK && s.routinesOK && !s.cloudOK)
} catch {
    check("model: coding threw \(error)", false)
}

// --- token store ---
do {
    let store = InMemoryTokenStore()
    try store.save("abc")
    let loaded = store.load()
    try store.clear()
    check("token: in-memory round-trip", loaded == "abc" && store.load() == nil)
} catch {
    check("token: threw \(error)", false)
}

print(failures == 0 ? "\nanchorcheck: ALL PASS" : "\nanchorcheck: \(failures) FAILURE(S)")
exit(failures == 0 ? 0 : 1)
