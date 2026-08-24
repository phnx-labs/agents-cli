// The one `vscode` module double every test registers with `mock.module`.
//
// bun's module-mock registry is process-global and the LAST file to register a
// specifier wins for every module that already imported it — the registration
// is not scoped to the file that made it. Each test file used to hand-roll its
// own partial `vscode` object, so which parts of the API existed during a suite
// run was decided by whichever mocking file happened to load last. That is how
// `terminalReadiness.close.test.ts` passed on its own and failed all six of its
// assertions in the suite: `watchdog.vscode.test.ts` sorts last and its double
// has no `TerminalExitReason`, so `shouldTearDownAgentOnClose`'s
// `vscode.TerminalExitReason.User` read threw.
//
// API *constants* are the part that must not vary — they are fixed by the VS
// Code API, not by what a given test is exercising. They live here once and are
// merged into every double, so the winning registration always carries the full
// set. Per-file spies (a `window` that records the messages it was shown, a
// `workspace` backed by a temp dir) stay in the test that asserts on them.

/**
 * Enum values fixed by the VS Code extension API, mirrored for tests that run
 * without an extension host. `TerminalExitReason` has been stable since API
 * 1.77, `ConfigurationTarget` since 1.0.
 */
export const VSCODE_API_CONSTANTS = {
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
} as const;

/**
 * Build a `vscode` double: the shared API constants plus whatever surface this
 * test drives. Pass the result to `mock.module('vscode', () => vscodeDouble({…}))`.
 */
export function vscodeDouble<T extends Record<string, unknown>>(
  surface: T = {} as T,
): T & typeof VSCODE_API_CONSTANTS {
  return { ...VSCODE_API_CONSTANTS, ...surface };
}
