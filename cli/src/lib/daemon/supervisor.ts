/**
 * ServiceSupervisor (RUSH-3193 P1).
 *
 * Owns the timer for every registered `PeriodicService`, replacing the bare
 * `setInterval` closures in `runDaemon()`. Two failure modes motivated it,
 * both observed in production:
 *
 *  - A throw escaping a tick's local try/catch used to hit the process-wide
 *    `uncaughtException` handler and `process.exit(1)` the whole daemon,
 *    taking every OTHER service down with it. Here, a tick failure is caught
 *    per-service and never propagates past `runTick`.
 *  - A tick that hangs on an unbounded await (SSH, keychain) used to latch its
 *    local in-flight guard `true` forever, silently freezing that one service
 *    for the daemon's life (observed ~51h). Here, every tick races a
 *    `deadlineMs` timeout; when the deadline wins, that service is parked and
 *    its in-flight guard stays held until the real promise settles. This keeps
 *    a timed-out tick from overlapping another tick or lifecycle transition.
 *
 * Repeated failures (thrown or timed-out) open a circuit breaker: the service
 * is parked (its timer stopped) and retried on exponential backoff via its own
 * `restart()`, while every sibling service keeps ticking on its own timer,
 * unaffected.
 */

import { recordSubsystemOk, recordSubsystemError, recordSubsystemState } from '../daemon-health.js';
import type { DaemonServiceId } from '../daemon-services.js';
import type { DaemonContext, DaemonService, PeriodicService, ServiceHealth, ServiceState } from './service.js';
import { isPeriodicService } from './service.js';

export interface ServiceSupervisorOptions {
  /** Consecutive thrown tick failures before a service is parked. Deadline breaches park immediately. Default 3. */
  parkAfterFailures?: number;
  /** First restart backoff delay, doubled on each further failed restart attempt. Default 5s. */
  backoffBaseMs?: number;
  /** Backoff ceiling. Default 5 minutes. */
  backoffMaxMs?: number;
}

interface RegisteredService {
  service: DaemonService;
  state: ServiceState;
  lastRunMs: number;
  lastError?: string;
  consecutiveFailures: number;
  restartAttempts: number;
  inFlight: boolean;
  activeTick?: Promise<void>;
  /** True once `start()` has completed without throwing — guards `stop()` from being called on a service that never successfully started. */
  everStarted: boolean;
  timer?: ReturnType<typeof setInterval>;
  restartTimer?: ReturnType<typeof setTimeout>;
  startupTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_PARK_AFTER_FAILURES = 3;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;

export class ServiceSupervisor {
  private readonly registry = new Map<DaemonServiceId, RegisteredService>();
  private ctx: DaemonContext | null = null;
  private readonly parkAfterFailures: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(opts: ServiceSupervisorOptions = {}) {
    this.parkAfterFailures = opts.parkAfterFailures ?? DEFAULT_PARK_AFTER_FAILURES;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  }

  /**
   * Register a service. Must be called before `startAll()`.
   *
   * Accepts both `PeriodicService` (ticked on a fixed interval) and
   * lifecycle-only `DaemonService` (started once, stopped at shutdown). The
   * supervisor uses `isPeriodicService()` to decide whether to schedule a timer
   * for each registered entry.
   */
  register(service: DaemonService): void {
    if (this.registry.has(service.id)) throw new Error(`service '${service.id}' is already registered`);
    this.registry.set(service.id, {
      service,
      state: 'idle',
      lastRunMs: 0,
      consecutiveFailures: 0,
      restartAttempts: 0,
      inFlight: false,
      everStarted: false,
    });
  }

  /** Start every registered service and begin ticking each on its own timer. */
  async startAll(ctx: DaemonContext): Promise<void> {
    this.ctx = ctx;
    for (const id of this.registry.keys()) await this.startOne(id);
  }

  /** Stop every registered service and clear all timers. */
  async stopAll(): Promise<void> {
    for (const id of this.registry.keys()) await this.stopOne(id, true);
  }

  /** Force one service to restart right now, outside its normal backoff schedule. Drives `agents daemon services restart <id>` (RUSH-3193 P4). */
  async restartOne(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.inFlight) {
      throw new Error(`service '${id}' cannot restart while a tick is still in flight`);
    }
    // A live periodic service already owns an interval. attemptRestart() installs
    // a fresh one after restart, so leaving the existing handles alive would
    // multiply the tick rate on every operator-requested restart.
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
      entry.startupTimer = undefined;
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    // Block a timer callback already queued in this event-loop turn while the
    // service tears down and starts again.
    entry.state = 'parked';
    recordSubsystemState(id, 'parked');
    await this.attemptRestart(id);
  }

  /** Whether `id` is registered on this supervisor. A service disabled at daemon boot is never registered — see {@link start}. */
  isRegistered(id: DaemonServiceId): boolean {
    return this.registry.has(id);
  }

  /** Every currently registered service id. */
  registeredIds(): DaemonServiceId[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Start one registered service live — drives `agents daemon services enable
   * <id>` (RUSH-3193 P4). Only affects a service already registered on this
   * supervisor: one disabled at daemon boot was never constructed or
   * registered, so enabling it live is not possible without a daemon restart
   * (the CLI falls back to that advice — see `commands/daemon.ts`).
   */
  async start(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.state === 'running') return;
    if (entry.inFlight) {
      throw new Error(`service '${id}' cannot start while a tick is still in flight`);
    }
    await this.startOne(id);
  }

  /** Stop one registered service live — drives `agents daemon services disable <id>` (RUSH-3193 P4). */
  async stop(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.state === 'stopped') return;
    await this.stopOne(id, false);
  }

  /** Request an immediate supervised tick, used by event edges that cannot wait for the regular cadence. */
  runNow(id: DaemonServiceId): void {
    if (!this.registry.has(id)) throw new Error(`service '${id}' is not registered`);
    void this.runTick(id);
  }

  /** Health for every registered service, keyed by service id. */
  health(): Record<string, ServiceHealth> {
    const out: Record<string, ServiceHealth> = {};
    for (const [id, entry] of this.registry) {
      out[id] = {
        state: entry.state,
        lastRunMs: entry.lastRunMs,
        lastError: entry.lastError,
        consecutiveFailures: entry.consecutiveFailures,
      };
    }
    return out;
  }

  private async startOne(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    const ctx = this.ctx;
    if (!entry || !ctx) return;
    try {
      await entry.service.start(ctx);
    } catch (err) {
      this.recordFailure(entry, id, err);
      this.park(id);
      return;
    }
    entry.everStarted = true;
    entry.state = 'running';
    recordSubsystemState(id, 'running');
    if (isPeriodicService(entry.service)) {
      const startupDelayMs = entry.service.startupDelayMs ?? 0;
      if (startupDelayMs > 0) {
        // Defer BOTH the first tick and the recurring interval's start until the
        // delay elapses — starting the interval at t=0 would fire its own ticks
        // on top of the staggered one instead of after it.
        entry.startupTimer = setTimeout(() => {
          entry.startupTimer = undefined;
          this.scheduleTimer(id);
          void this.runTick(id);
        }, startupDelayMs);
      } else {
        this.scheduleTimer(id);
        void this.runTick(id);
      }
    } else {
      // Lifecycle-only service: record health once on successful start (no ticks).
      entry.lastRunMs = Date.now();
      recordSubsystemOk(id);
    }
  }

  private async stopOne(id: DaemonServiceId, force: boolean): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) return;
    if (entry.inFlight && !force) {
      throw new Error(`service '${id}' cannot stop while a tick is still in flight`);
    }
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
      entry.startupTimer = undefined;
    }
    entry.state = 'stopped';
    recordSubsystemState(id, 'stopped');
    // Whole-daemon shutdown must not hang forever on an unresolved tick, but it
    // also must not tear down resources the tick may still be using. Stop its
    // timers and mark it stopped; process exit owns final cleanup in this case.
    if (entry.inFlight && force) return;
    if (!entry.everStarted) return; // start() never succeeded — nothing to stop.
    try {
      await entry.service.stop();
    } catch (err) {
      this.ctx?.log('WARN', `service '${id}' stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private scheduleTimer(id: DaemonServiceId): void {
    const entry = this.registry.get(id);
    if (!entry || !isPeriodicService(entry.service)) return;
    entry.timer = setInterval(() => { void this.runTick(id); }, entry.service.intervalMs);
  }

  /**
   * Run one tick under a hard deadline. The deadline is enforced with
   * `Promise.race`, not true cancellation — JS cannot abort an arbitrary
   * in-flight await. A timeout parks the service immediately but deliberately
   * keeps `inFlight` set until the REAL promise settles. Starting another tick
   * or tearing resources down underneath the abandoned one would trade a
   * visible parked service for duplicated side effects and lifecycle races.
   */
  private async runTick(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    const ctx = this.ctx;
    if (!entry || !ctx || entry.state !== 'running' || entry.inFlight) return;
    // runTick is only called for periodic services (from scheduleTimer and startOne).
    // The isPeriodicService guard here keeps TypeScript narrowing correct.
    if (!isPeriodicService(entry.service)) return;
    const periodicService = entry.service;
    entry.inFlight = true;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const tickPromise = periodicService.tick(ctx);
    entry.activeTick = tickPromise;
    try {
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => {
            timedOut = true;
            reject(new Error(`tick exceeded deadline of ${periodicService.deadlineMs}ms`));
          },
          periodicService.deadlineMs,
        );
      });
      await Promise.race([tickPromise, deadline]);
      entry.consecutiveFailures = 0;
      entry.lastError = undefined;
      entry.lastRunMs = Date.now();
      recordSubsystemOk(id);
    } catch (err) {
      this.recordFailure(entry, id, err);
      if (timedOut || entry.consecutiveFailures >= this.parkAfterFailures) this.park(id);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (timedOut) {
        // Promise.race cannot cancel arbitrary work. Keep the service parked and
        // in-flight until the REAL tick settles; only then may backoff restart it.
        void tickPromise.then(
          () => this.finishTick(id, tickPromise),
          () => this.finishTick(id, tickPromise),
        );
      } else {
        this.finishTick(id, tickPromise);
      }
    }
  }

  private park(id: DaemonServiceId): void {
    const entry = this.registry.get(id);
    if (!entry || entry.state === 'parked' || entry.state === 'stopped') return;
    entry.state = 'parked';
    recordSubsystemState(id, 'parked');
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    this.ctx?.log('WARN', `service '${id}' parked after ${entry.consecutiveFailures} consecutive failure(s)`);
    if (!entry.inFlight) this.scheduleRestart(id);
  }

  private scheduleRestart(id: DaemonServiceId): void {
    const entry = this.registry.get(id);
    if (!entry) return;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** entry.restartAttempts);
    entry.restartAttempts += 1;
    entry.restartTimer = setTimeout(() => { void this.attemptRestart(id); }, delay);
  }

  private async attemptRestart(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    const ctx = this.ctx;
    if (!entry || !ctx || entry.state === 'stopped') return;
    try {
      await entry.service.restart();
      entry.everStarted = true; // restart() is stop()+start() on the service — a successful one means it is running again and owes a stop() at shutdown.
      entry.state = 'running';
      recordSubsystemState(id, 'running');
      entry.consecutiveFailures = 0;
      entry.restartAttempts = 0;
      entry.lastError = undefined;
      if (isPeriodicService(entry.service)) {
        this.scheduleTimer(id);
        void this.runTick(id);
      } else {
        entry.lastRunMs = Date.now();
      }
      recordSubsystemOk(id);
      ctx.log('INFO', `service '${id}' restarted`);
    } catch (err) {
      this.recordFailure(entry, id, err);
      entry.state = 'parked';
      recordSubsystemState(id, 'parked');
      this.scheduleRestart(id);
    }
  }

  private recordFailure(entry: RegisteredService, id: DaemonServiceId, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    entry.consecutiveFailures += 1;
    entry.lastError = message;
    recordSubsystemError(id, message);
    this.ctx?.log('WARN', `service '${id}' failed: ${message}`);
  }

  private finishTick(id: DaemonServiceId, tickPromise: Promise<void>): void {
    const entry = this.registry.get(id);
    if (!entry || entry.activeTick !== tickPromise) return;
    entry.activeTick = undefined;
    entry.inFlight = false;
    if (entry.state === 'parked' && !entry.restartTimer) this.scheduleRestart(id);
  }
}
