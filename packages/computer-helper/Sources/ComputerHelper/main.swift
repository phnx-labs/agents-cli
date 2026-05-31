import AppKit
import Foundation

// Line-delimited JSON-RPC.
// Each line in:  {"id":N,"method":"...","params":{...}}
// Each line out: {"id":N,"result":{...}} or {"id":N,"error":{"code":"...","message":"..."}}
//
// Two transports:
//   - default: stdio (legacy, one-shot helper spawned by parent per call)
//   - --socket <path> or env COMPUTER_HELPER_SOCKET: listen on a Unix domain
//     socket, accept many concurrent connections, each with its own line-
//     delimited JSON-RPC channel. Used by the launchd-managed daemon.
//
// Initialize the WindowServer/SkyLight connection. ScreenCaptureKit asserts
// CGS_REQUIRE_INIT inside SCScreenshotManager when invoked from a process
// that hasn't touched AppKit yet. Bare `swift` CLI processes and our helper
// (LSUIElement, no run loop) both hit this. Touching NSApplication.shared
// is enough to bootstrap the connection without starting a run loop.
//
// We also need the run loop running on the main thread so CursorSprite can
// display its overlay NSWindow when the agent clicks. The RPC reader
// therefore moves to a background queue; NSApp.run() owns main.
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.accessory)

let stderr = FileHandle.standardError

func log(_ msg: String) {
    stderr.write("[computer-helper] \(msg)\n".data(using: .utf8)!)
}

// Allow-list policy. Mutated at startup (from disk) and on every SIGHUP.
// File scope so RPC.swift can read it without an instance handle. The
// helper boots with allow=[] which means every action gets rejected —
// the safe default if the policy file is missing, unreadable, or empty.
struct Policy {
    var allow: Set<String> = []
}

var policy = Policy()

// Peer-auth allow list — which caller executables may connect to the
// socket. Same fail-safe semantics as `policy`: missing/unparseable file
// means empty set means no peer is allowed to connect. The CLI rewrites
// this file at every `start`/`reload`, so the daemon picks up new caller
// paths (npm-global upgrades, new Rush.app installs) on SIGHUP.
struct Peers {
    var allow: Set<String> = []
}

var peers = Peers()

// Resolve the policy file path. Env override mirrors the socket-path
// override so tests can point us at a scratch file. Default lives next to
// the socket under ~/.agents/.cache/helpers/.
func resolvePolicyPath() -> String {
    if let env = ProcessInfo.processInfo.environment["COMPUTER_HELPER_POLICY"], !env.isEmpty {
        return env
    }
    return "\(NSHomeDirectory())/.agents/.cache/helpers/computer-policy.json"
}

func resolvePeersPath() -> String {
    if let env = ProcessInfo.processInfo.environment["COMPUTER_HELPER_PEERS"], !env.isEmpty {
        return env
    }
    return "\(NSHomeDirectory())/.agents/.cache/helpers/computer-peers.json"
}

// Load (or reload) the policy file. Errors are logged but never thrown:
// the helper keeps running with whatever it last had, with the explicit
// exception that "file missing" resets the allow list to empty so an
// uninstall of permissions takes effect on SIGHUP.
func loadPolicy() {
    let path = resolvePolicyPath()
    guard FileManager.default.fileExists(atPath: path) else {
        log("policy file missing at \(path) — empty allow list (fail-safe)")
        policy = Policy()
        return
    }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
        log("policy file unreadable at \(path) — keeping previous allow list (\(policy.allow.count) entries)")
        return
    }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let allow = json["allow"] as? [String] else {
        log("policy file unparseable at \(path) — empty allow list (fail-safe)")
        policy = Policy()
        return
    }
    policy = Policy(allow: Set(allow))
    log("policy loaded: \(allow.count) allowed bundle ids")
}

// Mirror of loadPolicy() for the peer-auth allow list. Same fail-safe
// behavior: missing or unparseable = empty set = no caller may connect.
func loadPeers() {
    let path = resolvePeersPath()
    guard FileManager.default.fileExists(atPath: path) else {
        log("peers file missing at \(path) — empty allow list (fail-safe, all connections will be refused)")
        peers = Peers()
        return
    }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
        log("peers file unreadable at \(path) — keeping previous allow list (\(peers.allow.count) entries)")
        return
    }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let allow = json["allow"] as? [String] else {
        log("peers file unparseable at \(path) — empty allow list (fail-safe)")
        peers = Peers()
        return
    }
    peers = Peers(allow: Set(allow))
    log("peers loaded: \(allow.count) allowed caller paths")
}

// Resolve the peer (caller) pid for an accepted client fd via the
// LOCAL_PEERPID socket option. Returns nil if the kernel call fails —
// caller should refuse the connection.
private let SOL_LOCAL_C: Int32 = 0          // <sys/un.h>: SOL_LOCAL
private let LOCAL_PEERPID_C: Int32 = 0x002  // <sys/un.h>: LOCAL_PEERPID
private let PROC_PIDPATH_MAX: Int = 4 * 1024 // PROC_PIDPATHINFO_MAXSIZE = 4*MAXPATHLEN

func peerPid(fd: Int32) -> pid_t? {
    var pid: pid_t = 0
    var size = socklen_t(MemoryLayout<pid_t>.size)
    let r = withUnsafeMutablePointer(to: &pid) { ptr -> Int32 in
        return ptr.withMemoryRebound(to: UInt8.self, capacity: MemoryLayout<pid_t>.size) { raw in
            return getsockopt(fd, SOL_LOCAL_C, LOCAL_PEERPID_C, raw, &size)
        }
    }
    if r != 0 { return nil }
    if pid <= 0 { return nil }
    return pid
}

// Resolve a pid to its executable path via libproc proc_pidpath(). Returns
// nil if the process has already exited or the kernel call fails.
func execPathForPid(_ pid: pid_t) -> String? {
    var buf = [CChar](repeating: 0, count: PROC_PIDPATH_MAX)
    let n = proc_pidpath(pid, &buf, UInt32(PROC_PIDPATH_MAX))
    if n <= 0 { return nil }
    return String(cString: buf)
}

// Check whether an accepted fd's peer is on the allow list. Logs both
// allowed and denied outcomes for the audit trail. Sends one structured
// error frame on denial so a legitimate-but-misconfigured client knows
// what's wrong, then closes.
func authorizePeer(fd: Int32) -> Bool {
    guard let pid = peerPid(fd: fd) else {
        log("peer-auth: LOCAL_PEERPID failed for fd=\(fd) — closing")
        return false
    }
    guard let execPath = execPathForPid(pid) else {
        log("peer-auth: proc_pidpath failed for pid=\(pid) — closing")
        return false
    }
    if peers.allow.contains(execPath) {
        log("peer-auth: pid=\(pid) exec=\(execPath) — allowed")
        return true
    }
    log("peer-auth: pid=\(pid) exec=\(execPath) — DENIED (not in peers list)")
    if let frame = encodeResponse([
        "id": NSNull(),
        "error": [
            "code": "peer_denied",
            "message": "caller exec \(execPath) (pid \(pid)) is not in the peer allow list — `agents computer reload` re-derives it from this binary",
        ],
    ]) {
        _ = frame.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, frame.count) }
    }
    return false
}

// Resolve socket path: --socket <path> argv, else env COMPUTER_HELPER_SOCKET.
// If neither is set, fall back to stdio mode.
func resolveSocketPath() -> String? {
    let args = CommandLine.arguments
    if let idx = args.firstIndex(of: "--socket"), idx + 1 < args.count {
        return args[idx + 1]
    }
    if let env = ProcessInfo.processInfo.environment["COMPUTER_HELPER_SOCKET"], !env.isEmpty {
        return env
    }
    return nil
}

let cache = ElementCache()
let dispatcher = Dispatcher(cache: cache)

// Encode one RPC response. Shared by both transports.
func encodeResponse(_ obj: [String: Any]) -> Data? {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
        return nil
    }
    var out = data
    out.append(0x0A) // newline
    return out
}

// Handle one parsed line of JSON. Returns the response bytes ready to write.
func handleLine(_ line: Data) -> Data? {
    do {
        guard let obj = try JSONSerialization.jsonObject(with: line) as? [String: Any],
              let id = obj["id"],
              let method = obj["method"] as? String
        else {
            return encodeResponse(["id": NSNull(), "error": ["code": "bad_request", "message": "malformed JSON-RPC"]])
        }
        let params = obj["params"] as? [String: Any] ?? [:]

        let response: [String: Any]
        do {
            let result = try dispatcher.dispatch(method: method, params: params)
            response = ["id": id, "result": result]
        } catch let err as RPCError {
            response = ["id": id, "error": ["code": err.code, "message": err.message]]
        } catch {
            response = ["id": id, "error": ["code": "internal", "message": "\(error)"]]
        }
        return encodeResponse(response)
    } catch {
        return encodeResponse(["id": NSNull(), "error": ["code": "bad_request", "message": "\(error)"]])
    }
}

log("started pid=\(getpid())")

// Load the allow-list policy + peer-auth list before accepting any RPC
// calls. SIGHUP from the CLI's `agents computer reload` triggers a reload
// of both.
loadPolicy()
loadPeers()

let sighupSource = DispatchSource.makeSignalSource(signal: SIGHUP, queue: .main)
sighupSource.setEventHandler {
    log("SIGHUP — reloading policy + peers")
    loadPolicy()
    loadPeers()
}
sighupSource.resume()
signal(SIGHUP, SIG_IGN) // DispatchSource needs the libc handler ignored

if let socketPath = resolveSocketPath() {
    // ---- Socket transport ----
    //
    // Long-lived daemon. launchd starts us at login with --socket, KeepAlive
    // restarts us on crash. Multiple connections share the dispatcher (the
    // ElementCache is already thread-safe via its internal queue).

    log("socket mode: \(socketPath)")

    // Clean any stale socket file from a crashed previous instance.
    let fm = FileManager.default
    if fm.fileExists(atPath: socketPath) {
        try? fm.removeItem(atPath: socketPath)
        log("removed stale socket at \(socketPath)")
    }

    // Create listening socket.
    let listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
    if listenFd < 0 {
        log("socket() failed: errno=\(errno)")
        exit(1)
    }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
    let sunPathSize = MemoryLayout.size(ofValue: addr.sun_path)
    let maxLen = sunPathSize - 1
    if pathBytes.count > maxLen {
        log("socket path too long (max \(maxLen)): \(socketPath)")
        exit(1)
    }
    withUnsafeMutablePointer(to: &addr.sun_path) { pathPtr in
        pathPtr.withMemoryRebound(to: CChar.self, capacity: sunPathSize) { cstr in
            for i in 0..<pathBytes.count {
                cstr[i] = CChar(pathBytes[i])
            }
            cstr[pathBytes.count] = 0
        }
    }

    let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
            return Darwin.bind(listenFd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if bindResult < 0 {
        log("bind() failed: errno=\(errno) path=\(socketPath)")
        close(listenFd)
        exit(1)
    }

    // 0600 — owner-only. The socket lives under ~/.agents/ which is already
    // user-owned, but be explicit.
    if chmod(socketPath, 0o600) != 0 {
        log("chmod 0600 failed: errno=\(errno)")
    }

    if Darwin.listen(listenFd, 32) < 0 {
        log("listen() failed: errno=\(errno)")
        close(listenFd)
        exit(1)
    }

    log("listening on \(socketPath)")

    // Signal handlers: unlink socket then exit so the next launchd restart
    // can bind cleanly. unlink/_exit are signal-safe; the socketPath cstr
    // lives in the global Swift String storage.
    signal(SIGPIPE, SIG_IGN) // peer close shouldn't kill us

    // DispatchSource signal handlers can call into Swift safely.
    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termSource.setEventHandler {
        log("SIGTERM — unlinking socket")
        unlink(socketPath)
        exit(0)
    }
    termSource.resume()
    signal(SIGTERM, SIG_IGN)

    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    intSource.setEventHandler {
        log("SIGINT — unlinking socket")
        unlink(socketPath)
        exit(0)
    }
    intSource.resume()
    signal(SIGINT, SIG_IGN)

    // atexit also unlinks for any other exit path.
    atexit_b {
        unlink(socketPath)
    }

    // Accept loop on a dedicated background queue.
    DispatchQueue.global(qos: .userInitiated).async {
        while true {
            var clientAddr = sockaddr_un()
            var clientLen = socklen_t(MemoryLayout<sockaddr_un>.size)
            let clientFd = withUnsafeMutablePointer(to: &clientAddr) { ptr -> Int32 in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    return Darwin.accept(listenFd, sockPtr, &clientLen)
                }
            }
            if clientFd < 0 {
                if errno == EINTR { continue }
                log("accept() failed: errno=\(errno)")
                continue
            }

            // Handle the connection on its own queue.
            DispatchQueue.global(qos: .userInteractive).async {
                handleConnection(fd: clientFd)
            }
        }
    }

    NSApplication.shared.run()
} else {
    // ---- Stdio transport (legacy) ----
    //
    // Parent process spawns helper, writes one or more JSON-RPC lines, reads
    // responses, closes stdin. Helper exits on EOF.

    let stdin = FileHandle.standardInput
    let stdout = FileHandle.standardOutput
    let writeLock = NSLock()

    func writeLineStdio(_ data: Data) {
        writeLock.lock()
        stdout.write(data)
        writeLock.unlock()
    }

    DispatchQueue.global(qos: .userInteractive).async {
        var buffer = Data()
        while true {
            let chunk = stdin.availableData
            if chunk.isEmpty {
                log("exit (stdin EOF)")
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            buffer.append(chunk)

            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: 0..<nl)
                buffer.removeSubrange(0...nl)
                guard !line.isEmpty else { continue }
                if let resp = handleLine(line) {
                    writeLineStdio(resp)
                }
            }
        }
    }

    NSApplication.shared.run()
}

// Handle one accepted connection. Line-delimited JSON-RPC, same wire format
// as stdio. Runs on a background queue; serializes writes via a per-
// connection lock.
//
// Peer-auth (F5): before reading any RPC bytes, resolve the connecting
// pid via LOCAL_PEERPID and its exec path via proc_pidpath. If that path
// isn't in `peers.allow`, send one structured `peer_denied` frame and
// close. This blocks the obvious `nc -U socket` exfil — nc's exec path
// won't be in the allow list — and forces the user to explicitly trust
// any non-default caller via `agents computer trust <path>`.
func handleConnection(fd: Int32) {
    guard authorizePeer(fd: fd) else {
        close(fd)
        return
    }
    let writeLock = NSLock()
    func writeData(_ data: Data) {
        writeLock.lock()
        defer { writeLock.unlock() }
        let bytes = [UInt8](data)
        var remaining = bytes.count
        var offset = 0
        while remaining > 0 {
            let n = bytes.withUnsafeBufferPointer { bp -> Int in
                return Darwin.write(fd, bp.baseAddress!.advanced(by: offset), remaining)
            }
            if n <= 0 {
                if errno == EINTR { continue }
                return // peer gone
            }
            offset += n
            remaining -= n
        }
    }

    var buffer = Data()
    var readBuf = [UInt8](repeating: 0, count: 8192)

    while true {
        let n = readBuf.withUnsafeMutableBufferPointer { bp -> Int in
            return Darwin.read(fd, bp.baseAddress!, bp.count)
        }
        if n == 0 {
            close(fd)
            return
        }
        if n < 0 {
            if errno == EINTR { continue }
            close(fd)
            return
        }
        buffer.append(readBuf, count: n)

        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: 0..<nl)
            buffer.removeSubrange(0...nl)
            guard !line.isEmpty else { continue }
            if let resp = handleLine(line) {
                writeData(resp)
            }
        }
    }
}
