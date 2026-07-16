import Foundation
import AnchorKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// anchorprobe — end-to-end check of AnchorKit against a REAL `agents serve
// --control` anchor. Not part of the app; a verification harness.
//
//   ANCHOR_URL=http://127.0.0.1:4477 ANCHOR_TOKEN=<token> \
//   ANCHOR_SESSION=<id> swift run anchorprobe
//
// Exercises: fetchState (GET /api/state), an optional stream tail
// (GET /api/session/:id/stream) when ANCHOR_SESSION is set, and a 401 check with
// a bad token. Prints one line per check and exits non-zero on failure.

let env = ProcessInfo.processInfo.environment
guard let urlString = env["ANCHOR_URL"], let baseURL = URL(string: urlString) else {
    FileHandle.standardError.write(Data("set ANCHOR_URL\n".utf8)); exit(2)
}
let token = env["ANCHOR_TOKEN"] ?? ""

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("FAIL: \(msg)\n".utf8)); exit(1)
}

let sema = DispatchSemaphore(value: 0)
Task {
    let client = AnchorClient(baseURL: baseURL, token: token)

    // 1. fetchState
    do {
        let state = try await client.fetchState()
        print("state OK — generatedAt=\(state.generatedAt) teams=\(state.teamsOK) routines=\(state.routinesOK) cloud=\(state.cloudOK)")
    } catch { fail("fetchState: \(error)") }

    // 2. 401 with a bad token
    do {
        _ = try await AnchorClient(baseURL: baseURL, token: "definitely-wrong").fetchState()
        fail("bad token was accepted")
    } catch AnchorError.unauthorized {
        print("bad-token OK — 401 as expected")
    } catch { fail("unexpected error on bad token: \(error)") }

    // 3. stream tail (optional)
    if let session = env["ANCHOR_SESSION"] {
        var count = 0
        do {
            for try await ev in client.events(sessionId: session) {
                count += 1
                print("event \(count): id=\(ev.id.map(String.init) ?? "-") type=\(ev.type)")
                if ev.isTerminal { break }
            }
            print("stream OK — \(count) event(s)")
        } catch { fail("stream: \(error)") }
    }

    print("anchorprobe: all checks passed")
    sema.signal()
}
sema.wait()
