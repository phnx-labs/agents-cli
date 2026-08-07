import Foundation

// Routine-reliability self-test (RUSH-2290): the menu bar stays a thin reader
// of `agents routines list --json`, but that JSON is growing new optional
// fields from the runtime-core track (readiness, failureCode, execution
// project/cwd, blocked/skipped status, activeRunId). This exercises real
// `Routine` decoding against both an OLD payload (predating every new field)
// and a NEW one, then the pure classification/formatting/action-state helpers
// in StatusItemController.swift that read those fields — no GUI, no NSMenu
// construction (see the file-level note on why: NSStatusItem/NSMenu need an
// AppKit run loop this self-test deliberately never reaches). Gated by
// MENUBAR_ROUTINE_TEST=1 (main.swift). Mirrors ActiveSessionSelfTest /
// LoadedDeviceSelfTest.
enum RoutineSelfTest {
    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL") — \(name)")
            if !cond { pass = false }
        }

        let decoder = JSONDecoder()

        // MARK: Backward compatibility — a payload from a CLI that predates
        // every RUSH-2290 field must still decode, and every new field reads
        // nil, never a decode failure.
        let legacyJSON = """
        {"name":"check-updates","agent":"claude","workflow":null,"repo":null,
         "projects":null,"projectGroup":null,"schedule":"0 * * * *",
         "scheduleHuman":"hourly","enabled":true,"overdue":false,
         "nextRun":"2026-08-07T10:00:00Z","nextRunHuman":"in 10m",
         "lastStatus":"completed","exitCode":0,"failureReason":null,
         "lastRunStartedAt":null,"lastRunCompletedAt":null}
        """
        guard let legacy = try? decoder.decode(Routine.self, from: Data(legacyJSON.utf8)) else {
            print("FAIL — a pre-RUSH-2290 payload failed to decode")
            exit(1)
        }
        check("legacy payload decodes ready as nil", legacy.ready == nil)
        check("legacy payload decodes readiness as nil", legacy.readiness == nil)
        check("legacy payload decodes failureCode as nil", legacy.failureCode == nil)
        check("legacy payload decodes project/cwd fields as nil",
              legacy.project == nil && legacy.requestedCwd == nil && legacy.resolvedCwd == nil)
        check("legacy payload decodes skipReason/activeRunId as nil",
              legacy.skipReason == nil && legacy.activeRunId == nil)
        check("an absent `ready` is NOT not-ready (old CLI keeps old behavior)",
              !routineIsNotReady(legacy))
        check("a completed, non-overdue legacy routine needs no attention",
              !routineNeedsAttention(legacy))
        check("Run/Resume stay enabled with no readiness data at all",
              routineActionState(legacy).runEnabled)

        // MARK: blocked / skipped lastStatus — new terminal outcomes alongside
        // completed/failed/timeout/missed/running.
        let blockedJSON = """
        {"name":"deploy-web","agent":"codex","schedule":"0 9 * * *","enabled":true,
         "overdue":false,"lastStatus":"blocked","project":"web",
         "readiness":{"code":"agent_auth_failed","message":"codex is signed out"}}
        """
        guard let blocked = try? decoder.decode(Routine.self, from: Data(blockedJSON.utf8)) else {
            print("FAIL — a blocked-status payload failed to decode")
            exit(1)
        }
        check("lastStatus 'blocked' decodes", blocked.lastStatus == "blocked")
        check("readiness.code decodes", blocked.readiness?.code == "agent_auth_failed")
        check("a blocked last run classifies as .notReady, not .failure",
              routineAttentionKind(blocked) == .notReady)
        check("a blocked routine needs attention", routineNeedsAttention(blocked))
        check("blocked reason names the readiness message and target",
              routineFailureSummary(blocked, max: 80) == "codex is signed out · web")

        let skippedJSON = """
        {"name":"security-sweep","agent":"claude","schedule":"0 3 * * *","enabled":true,
         "overdue":false,"lastStatus":"skipped","skipReason":"active_run",
         "activeRunId":"run-abc123"}
        """
        guard let skipped = try? decoder.decode(Routine.self, from: Data(skippedJSON.utf8)) else {
            print("FAIL — a skipped-status payload failed to decode")
            exit(1)
        }
        check("skipReason decodes", skipped.skipReason == "active_run")
        check("activeRunId decodes", skipped.activeRunId == "run-abc123")
        check("a skipped run classifies as .miss (infra, not a task failure)",
              routineAttentionKind(skipped) == .miss)
        check("routineIsMiss agrees for skipped", routineIsMiss(skipped))
        check("skipped reason names the skip cause",
              routineFailureSummary(skipped, max: 40) == "skipped · active run")

        // MARK: readiness gating an ENABLED routine's NEXT run, independent of
        // the last run's own outcome (it can have completed fine).
        let notReadyJSON = """
        {"name":"linear-hygiene","agent":"claude","schedule":"0 8 * * *","enabled":true,
         "overdue":false,"lastStatus":"completed","ready":false,
         "readiness":{"code":"project_path_missing","message":"project directory no longer exists",
                       "repair":"agents routines edit linear-hygiene"},
         "project":"linear-hygiene","resolvedCwd":"/Users/m/repos/linear-hygiene"}
        """
        guard let notReady = try? decoder.decode(Routine.self, from: Data(notReadyJSON.utf8)) else {
            print("FAIL — a ready:false payload failed to decode")
            exit(1)
        }
        check("ready:false decodes", notReady.ready == false)
        check("readiness.repair decodes", notReady.readiness?.repair == "agents routines edit linear-hygiene")
        check("completed-but-not-ready classifies as .notReady, NOT .failure",
              routineAttentionKind(notReady) == .notReady)
        check("routineIsNotReady agrees", routineIsNotReady(notReady))
        check("a not-ready enabled routine needs attention even though its last run completed",
              routineNeedsAttention(notReady))
        check("not-ready reason prefers the readiness message + resolvedCwd target",
              routineFailureSummary(notReady, max: 120)
                == "project directory no longer exists · linear-hygiene")

        // A PAUSED routine (enabled:false) with the identical readiness block
        // must NOT be flagged — the operator already parked it; ready:false is
        // only actionable while the routine is still trying to run.
        let pausedNotReadyJSON = """
        {"name":"linear-hygiene","agent":"claude","schedule":"0 8 * * *","enabled":false,
         "overdue":false,"lastStatus":"completed","ready":false,
         "readiness":{"code":"project_path_missing","message":"project directory no longer exists"}}
        """
        guard let pausedNotReady = try? decoder.decode(Routine.self, from: Data(pausedNotReadyJSON.utf8)) else {
            print("FAIL — a paused ready:false payload failed to decode")
            exit(1)
        }
        check("a manually paused routine is NOT flagged even if it's also not-ready",
              !routineNeedsAttention(pausedNotReady))

        // MARK: Run/Resume gating — RoutineActionState is pure and AppKit-free.
        check("Run is disabled when ready is explicitly false",
              !routineActionState(notReady).runEnabled)
        check("Resume is disabled for a paused, not-ready routine (it would just fail again)",
              !routineActionState(pausedNotReady).pauseResumeEnabled)
        check("Pause stays enabled for an enabled-but-not-ready routine",
              routineActionState(notReady).pauseResumeEnabled)
        check("pauseResumeTitle reflects enabled state",
              routineActionState(legacy).pauseResumeTitle == "Pause"
                && routineActionState(pausedNotReady).pauseResumeTitle == "Resume")

        // MARK: a plain execution failure still classifies as .failure, not
        // .notReady or .miss — the three kinds are mutually exclusive.
        let failedJSON = """
        {"name":"crm-pipeline-brief","agent":"claude","schedule":"0 7 * * *","enabled":true,
         "overdue":false,"lastStatus":"failed","exitCode":1,
         "failureReason":"Please run /login","failureCode":"auth_failed"}
        """
        guard let failed = try? decoder.decode(Routine.self, from: Data(failedJSON.utf8)) else {
            print("FAIL — a failed-status payload failed to decode")
            exit(1)
        }
        check("failureCode decodes", failed.failureCode == "auth_failed")
        check("a real execution failure classifies as .failure",
              routineAttentionKind(failed) == .failure)
        check("failure reason is tagged with its failureCode",
              routineFailureSummary(failed, max: 80) == "auth_failed: Please run /login")
        check("Run stays enabled for a failed-but-ready routine (ready absent == true)",
              routineActionState(failed).runEnabled)

        // MARK: History… action wiring — a pure argv builder, not a live spawn.
        check("routineHistoryArgs shells 'routines runs <name>'",
              AgentsCLI.routineHistoryArgs("crm-pipeline-brief") == ["routines", "runs", "crm-pipeline-brief"])

        // MARK: grouping identical readiness causes — never inventing a shared
        // cause across routines that fail for genuinely different reasons.
        let sameCauseA = blocked
        let sameCauseBJSON = """
        {"name":"deploy-api","agent":"codex","schedule":"0 9 * * *","enabled":true,
         "overdue":false,"lastStatus":"blocked","project":"api",
         "readiness":{"code":"agent_auth_failed","message":"codex is signed out"}}
        """
        let sameCauseB = try! decoder.decode(Routine.self, from: Data(sameCauseBJSON.utf8))
        let groups = groupedByAttentionCause([sameCauseA, sameCauseB, failed])
        check("two routines sharing a readiness code collapse into one group",
              groups.contains { $0.0 == "agent_auth_failed" && $0.1.count == 2 })
        check("a routine with a distinct cause keeps its own group",
              groups.contains { $0.0 == "failed" && $0.1.count == 1 })
        check("readableAttentionCause never invents copy for an unknown code",
              readableAttentionCause("agent_auth_failed") == "agent auth failed")

        // MARK: bounded lists — NEEDS YOU attention groups and "All routines…"
        // both cap with a named "+N more" remainder rather than an unbounded
        // scroll (the constants StatusItemController's menu builders read).
        check("attention-group cap is a small, named number", StatusItemController.maxAttentionGroups > 0
              && StatusItemController.maxAttentionGroups < 20)
        check("all-routines cap is a named number", StatusItemController.maxAllRoutinesRows > 0)
        let manyCauses = (0..<(StatusItemController.maxAttentionGroups + 4)).map { i -> Routine in
            let json = """
            {"name":"r\(i)","agent":"claude","schedule":"0 9 * * *","enabled":true,
             "overdue":false,"lastStatus":"blocked","project":"p\(i)",
             "readiness":{"code":"cause_\(i)","message":"m\(i)"}}
            """
            return try! decoder.decode(Routine.self, from: Data(json.utf8))
        }
        let manyGroups = groupedByAttentionCause(manyCauses)
        check("every distinct cause gets its own group when none repeat",
              manyGroups.count == manyCauses.count)
        let cappedGroups = Array(manyGroups.prefix(StatusItemController.maxAttentionGroups))
        check("capping the groups to the constant drops the expected remainder",
              manyGroups.count - cappedGroups.count == 4)

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
