import Foundation

enum DaemonLivenessSelfTest {
    static func run() -> Never {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        // Exact Date.toISOString() wire format written by daemon.ts, including
        // the fractional seconds Swift's default ISO8601 formatter rejects.
        let fresh = heartbeat(pid: 42, stamp: "2027-01-15T07:59:00.000Z")
        let stale = heartbeat(pid: 42, stamp: "2027-01-15T07:56:59.000Z")

        assert(DaemonLiveness.classify(pid: nil, heartbeatData: nil, now: now) == .stopped, "missing pid is stopped")
        assert(DaemonLiveness.classify(pid: 42, heartbeatData: fresh, now: now) == .running, "fresh heartbeat is running")
        assert(DaemonLiveness.classify(pid: 42, heartbeatData: stale, now: now) == .wedged, "stale heartbeat is wedged")
        assert(DaemonLiveness.classify(pid: 42, heartbeatData: heartbeat(pid: 7, stamp: "2027-01-15T07:56:59.000Z"), now: now) == .running, "mismatched heartbeat fails closed")
        assert(DaemonLiveness.classify(pid: 42, heartbeatData: heartbeat(pid: 42, stamp: "2027-01-15T07:56:59Z"), now: now) == .wedged, "second-precision heartbeat remains compatible")
        assert(DaemonLiveness.classify(pid: 42, heartbeatData: Data("broken".utf8), now: now) == .running, "malformed heartbeat fails closed")

        print("PASS daemon-liveness")
        exit(0)
    }

    private static func heartbeat(pid: Int, stamp: String) -> Data {
        return Data("{\"lastTick\":\"\(stamp)\",\"pid\":\(pid)}".utf8)
    }

    private static func assert(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else {
            FileHandle.standardError.write(Data("FAIL daemon-liveness: \(message)\n".utf8))
            exit(1)
        }
    }
}
