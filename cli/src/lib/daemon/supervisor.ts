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
 *    `deadlineMs` timeout; when the deadline wins, the guard is released in
 *    `finally` regardless of whether the real tick promise ever settles, so
 *    the NEXT scheduled tick can still run.
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
  /** Consecutive tick failures (throw or deadline breach) before a service is parked. Default 3. */
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
  /** True once `start()` has completed without throwing — guards `stop()` from being called on a service that never successfully started. */
  everStarted: boolean;
  timer?: ReturnType<typeof setInterval>;
  restartTimer?: ReturnType<typeof setTimeout>;
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
    for (const id of this.registry.keys()) await this.stopOne(id);
  }

  /** Force one service to restart right now, outside its normal backoff schedule. Drives `agents daemon services restart <id>` (RUSH-3193 P4). */
  async restartOne(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
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
    await this.startOne(id);
  }

  /** Stop one registered service live — drives `agents daemon services disable <id>` (RUSH-3193 P4). */
  async stop(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`service '${id}' is not registered`);
    if (entry.state === 'stopped') return;
    await this.stopOne(id);
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
      this.scheduleTimer(id);
      void this.runTick(id);
    } else {
      // Lifecycle-only service: record health once on successful start (no ticks).
      entry.lastRunMs = Date.now();
      recordSubsystemOk(id);
    }
  }

  private async stopOne(id: DaemonServiceId): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) return;
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    entry.state = 'stopped';
    recordSubsystemState(id, 'stopped');
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
   * in-flight await. What matters for the freeze this replaces is that
   * `inFlight` is released in `finally` as soon as the race settles, so an
   * abandoned tick can never block the next scheduled one again.
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
    try {
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error(`tick exceeded deadline of ${periodicService.deadlineMs}ms`)),
          periodicService.deadlineMs,
        );
      });
      await Promise.race([periodicService.tick(ctx), deadline]);
      entry.consecutiveFailures = 0;
      entry.lastError = undefined;
      entry.lastRunMs = Date.now();
      recordSubsystemOk(id);
    } catch (err) {
      this.recordFailure(entry, id, err);
      if (entry.consecutiveFailures >= this.parkAfterFailures) this.park(id);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      entry.inFlight = false;
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
    this.scheduleRestart(id);
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
}
