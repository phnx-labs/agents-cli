// The standalone Electron host refreshes floor data on a fixed interval. That
// poll must PAUSE when the floor is hidden (the UI sends `unsubscribeFloor`) and
// RESUME when it's shown again (`subscribeFloor`) — mirroring the VS Code host's
// subscribeFloor / cleanupFloorWatchers lifecycle (settings.vscode.ts).
//
// Extracted from main.ts so the start/stop lifecycle is unit-testable without
// booting Electron: the timer functions are injectable.

type IntervalHandle = ReturnType<typeof setInterval>

export interface FloorPollDeps {
  setInterval?: (fn: () => void, ms: number) => IntervalHandle
  clearInterval?: (handle: IntervalHandle) => void
}

export class FloorPoll {
  private handle: IntervalHandle | null = null
  private readonly set: (fn: () => void, ms: number) => IntervalHandle
  private readonly clear: (handle: IntervalHandle) => void

  constructor(
    private readonly intervalMs: number,
    private readonly onTick: () => void,
    deps: FloorPollDeps = {},
  ) {
    this.set = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clear = deps.clearInterval ?? ((h) => clearInterval(h))
  }

  get running(): boolean {
    return this.handle !== null
  }

  // Idempotent: a second start() while already running does NOT open a second
  // interval (which would double the poll rate and leak a timer).
  start(): void {
    if (this.handle !== null) return
    this.handle = this.set(() => this.onTick(), this.intervalMs)
  }

  stop(): void {
    if (this.handle === null) return
    this.clear(this.handle)
    this.handle = null
  }
}
