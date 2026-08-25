/**
 * ServiceSupervisor (RUSH-3193 P1): per-service error boundary, per-tick
 * deadline, circuit breaker, and health reporting — exercised against fake
 * `DaemonService`/`PeriodicService` implementations, not the real
 * daemon-hosted services.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import type { DaemonContext, PeriodicService, ServiceHealth } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

let testDaemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  testDaemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-supervisor-'));
  process.env.AGENTS_DAEMON_DIR = testDaemonDir;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = originalDaemonDir;
  fs.rmSync(testDaemonDir, { recursive: true, force: true });
});

function makeCtx(): DaemonContext {
  return { log: () => {} };
}

/** A service that ticks successfully every time, counting how many ticks it ran. */
class HealthyService implements PeriodicService {
  readonly id: DaemonServiceId;
  readonly intervalMs = 1_000;
  readonly deadlineMs = 500;
  readonly startupDelayMs?: number;
  ticks = 0;
  started = false;
  stopped = false;

  constructor(id: DaemonServiceId, startupDelayMs?: number) {
    this.id = id;
    this.startupDelayMs = startupDelayMs;
  }

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
  async tick(): Promise<void> {
    this.ticks += 1;
  }
  health(): ServiceHealth {
    return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 };
  }
}

/** A service whose tick always throws. */
class ThrowingService implements PeriodicService {
  readonly id: DaemonServiceId = 'watchdog';
  readonly intervalMs = 1_000;
  readonly deadlineMs = 500;
  ticks = 0;
  restarts = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async restart(): Promise<void> {
    this.restarts += 1;
  }
  async tick(): Promise<void> {
    this.ticks += 1;
    throw new Error(`boom #${this.ticks}`);
  }
  health(): ServiceHealth {
    return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 };
  }
}

/** A service whose tick never resolves — simulates an unbounded SSH/keychain await. */
class HangingService implements PeriodicService {
  readonly id: DaemonServiceId = 'device-probe';
  readonly intervalMs = 1_000;
  readonly deadlineMs = 500;
  ticksStarted = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async restart(): Promise<void> {}
  async tick(): Promise<void> {
    this.ticksStarted += 1;
    return new Promise<void>(() => {}); // never settles
  }
  health(): ServiceHealth {
    return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 };
  }
}

describe('ServiceSupervisor', () => {
  it('a throwing service parks + reports unhealthy + restarts with backoff, while a healthy sibling keeps ticking', async () => {
    // backoffBaseMs kept well clear of the 1s tick interval so the restart
    // timer and sibling-tick assertions below never land on the same instant.
    const supervisor = new ServiceSupervisor({ parkAfterFailures: 3, backoffBaseMs: 5_000, backoffMaxMs: 20_000 });
    const bad = new ThrowingService();
    const good = new HealthyService('scheduler');
    supervisor.register(bad);
    supervisor.register(good);

    await supervisor.startAll(makeCtx());
    // Immediate first-tick fire (both services), plus enough ticks to cross the park threshold.
    await vi.advanceTimersByTimeAsync(0); // t=0: tick #1
    await vi.advanceTimersByTimeAsync(1_000); // t=1000: tick #2
    await vi.advanceTimersByTimeAsync(1_000); // t=2000: tick #3 -> parks (backoff scheduled for t=7000)

    let health = supervisor.health();
    expect(health['watchdog'].state).toBe('parked');
    expect(health['watchdog'].consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(health['watchdog'].lastError).toMatch(/boom/);
    // The daemon itself must stay up: the sibling never stopped ticking.
    expect(health['scheduler'].state).toBe('running');
    const goodTicksAtPark = good.ticks;
    expect(goodTicksAtPark).toBeGreaterThanOrEqual(3);
    expect(bad.ticks).toBe(3);

    // Sibling keeps advancing while the bad service sits parked (no more throws counted) — well
    // before the t=7000 backoff fire.
    await vi.advanceTimersByTimeAsync(1_000); // t=3000
    expect(good.ticks).toBeGreaterThan(goodTicksAtPark);
    expect(bad.ticks).toBe(3); // no ticks scheduled while parked

    // Advance past the scheduled backoff window and confirm a restart was attempted.
    await vi.advanceTimersByTimeAsync(5_000); // t=8000, past the t=7000 restart
    expect(bad.restarts).toBeGreaterThanOrEqual(1);
    health = supervisor.health();
    expect(health['watchdog'].state).toBe('running');

    await supervisor.stopAll();
  });

  it('a hanging tick is abandoned at the deadline, releasing the in-flight guard so the NEXT tick still runs; siblings unaffected', async () => {
    const supervisor = new ServiceSupervisor({ parkAfterFailures: 100 }); // keep it running through repeated timeouts
    const hanging = new HangingService();
    const good = new HealthyService('scheduler');
    supervisor.register(hanging);
    supervisor.register(good);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // first immediate tick starts

    expect(hanging.ticksStarted).toBe(1);
    // Advance past the 500ms deadline — the race rejects, guard releases.
    await vi.advanceTimersByTimeAsync(500);
    let health = supervisor.health();
    expect(health['device-probe'].consecutiveFailures).toBe(1);
    expect(health['device-probe'].lastError).toMatch(/deadline/);

    // Advance to the next scheduled interval tick (1000ms mark) — the guard being
    // released is what lets THIS tick start at all; before the fix it would still
    // be latched by the abandoned first tick and this call would be silently skipped.
    await vi.advanceTimersByTimeAsync(500);
    expect(hanging.ticksStarted).toBe(2);

    expect(good.ticks).toBeGreaterThanOrEqual(1);
    await supervisor.stopAll();
  });

  it('health() returns a record for every registered service', async () => {
    const supervisor = new ServiceSupervisor();
    const a = new HealthyService('scheduler');
    const b = new HealthyService('monitors');
    const c = new HealthyService('self-heal');
    supervisor.register(a);
    supervisor.register(b);
    supervisor.register(c);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);

    const health = supervisor.health();
    expect(Object.keys(health).sort()).toEqual(['monitors', 'scheduler', 'self-heal']);
    for (const id of ['scheduler', 'monitors', 'self-heal'] as const) {
      expect(health[id].state).toBe('running');
      expect(health[id].consecutiveFailures).toBe(0);
    }
    await supervisor.stopAll();
  });

  it('stopAll() stops every started service and clears timers (no further ticks)', async () => {
    const supervisor = new ServiceSupervisor();
    const svc = new HealthyService('scheduler');
    supervisor.register(svc);
    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    const ticksAtStop = svc.ticks;

    await supervisor.stopAll();
    expect(svc.stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.ticks).toBe(ticksAtStop);
    expect(supervisor.health()['scheduler'].state).toBe('stopped');
  });

  it('registering the same service id twice throws', () => {
    const supervisor = new ServiceSupervisor();
    supervisor.register(new HealthyService('scheduler'));
    expect(() => supervisor.register(new HealthyService('scheduler'))).toThrow(/already registered/);
  });

  it('a service with startupDelayMs defers its FIRST tick, then ticks on the normal interval — a service with no delay still ticks immediately (RUSH-3193 #17)', async () => {
    const supervisor = new ServiceSupervisor();
    const delayed = new HealthyService('self-heal', 30_000);
    const immediate = new HealthyService('scheduler');
    supervisor.register(delayed);
    supervisor.register(immediate);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    // Undelayed sibling still fires immediately at boot — startupDelayMs is opt-in per service.
    expect(immediate.ticks).toBe(1);
    // Delayed service must not have ticked yet.
    expect(delayed.ticks).toBe(0);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(delayed.ticks).toBe(0);

    await vi.advanceTimersByTimeAsync(1); // t=30_000: the staggered first tick fires
    expect(delayed.ticks).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000); // its normal 1s interval cadence resumes from here
    expect(delayed.ticks).toBe(2);

    await supervisor.stopAll();
  });

  it('stopAll() before the startup delay elapses cancels the pending first tick', async () => {
    const supervisor = new ServiceSupervisor();
    const delayed = new HealthyService('self-heal', 30_000);
    supervisor.register(delayed);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(delayed.ticks).toBe(0);

    await supervisor.stopAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delayed.ticks).toBe(0);
  });

  it('restartOne() forces an immediate restart outside the backoff schedule', async () => {
    const supervisor = new ServiceSupervisor();
    const bad = new ThrowingService();
    supervisor.register(bad);
    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // tick #1 throws, cf=1 (parkAfterFailures default 3, not parked yet)

    expect(supervisor.health()['watchdog'].state).toBe('running');
    await supervisor.restartOne('watchdog');
    expect(bad.restarts).toBe(1);
    // restartOne() clears the failure streak on the restart itself, then fires an
    // immediate tick like a fresh start — which throws again for this fixture,
    // so the streak is back to 1 rather than 0. The state stays 'running' either
    // way since parkAfterFailures (default 3) hasn't been reached again yet.
    expect(supervisor.health()['watchdog'].state).toBe('running');
    expect(supervisor.health()['watchdog'].consecutiveFailures).toBe(1);
  });

  it('a service that fails restart() after parking, then later restarts successfully, is stopped cleanly by stopAll() (everStarted set on restart, not just first start)', async () => {
    const supervisor = new ServiceSupervisor({ parkAfterFailures: 1, backoffBaseMs: 1_000, backoffMaxMs: 1_000 });

    class FlakyStartService implements PeriodicService {
      readonly id: DaemonServiceId = 'account-state';
      readonly intervalMs = 1_000;
      readonly deadlineMs = 500;
      startCalls = 0;
      stopCalls = 0;

      async start(): Promise<void> {
        this.startCalls += 1;
        if (this.startCalls === 1) throw new Error('first start fails');
      }
      async stop(): Promise<void> {
        this.stopCalls += 1;
      }
      async restart(): Promise<void> {
        await this.stop();
        await this.start();
      }
      async tick(): Promise<void> {}
      health(): ServiceHealth {
        return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 };
      }
    }

    const svc = new FlakyStartService();
    supervisor.register(svc);
    await supervisor.startAll(makeCtx()); // start() throws -> parked immediately, restart scheduled at t=1000

    expect(supervisor.health()['account-state'].state).toBe('parked');
    await vi.advanceTimersByTimeAsync(1_000); // backoff fires -> restart() succeeds this time
    expect(supervisor.health()['account-state'].state).toBe('running');
    expect(svc.startCalls).toBe(2);
    const stopCallsAfterRestart = svc.stopCalls; // restart() itself calls stop() once internally (=1)

    // Before the fix, `everStarted` was only set on the FIRST successful start() —
    // never on a successful restart() — so the supervisor's OWN stopOne() would
    // skip calling stop() again here even though the service is genuinely
    // running (distinct from the stop() restart() already made internally).
    await supervisor.stopAll();
    expect(svc.stopCalls).toBe(stopCallsAfterRestart + 1);
  });

  // RUSH-3193 P3 migrated watchdog, device-probe, self-heal, keychain-reap,
  // and state-dir-check onto the supervisor. The throw/hang mechanics above
  // already exercise 'watchdog' (ThrowingService) and 'device-probe'
  // (HangingService) by id; this closes the same two guarantees explicitly
  // for every id P3 migrated, proving the mechanism the concrete
  // `*-service.ts` wrappers rely on is id-agnostic.
  describe('RUSH-3193 P3 migrated ids: throw parks, hang hits deadline', () => {
    const P3_IDS: DaemonServiceId[] = ['watchdog', 'device-probe', 'self-heal', 'keychain-reap', 'state-dir-check'];

    it.each(P3_IDS)('%s: a throwing tick parks the service after parkAfterFailures, without crashing a healthy sibling', async (id) => {
      const supervisor = new ServiceSupervisor({ parkAfterFailures: 3, backoffBaseMs: 5_000, backoffMaxMs: 20_000 });
      class NamedThrowingService extends ThrowingService {
        readonly id = id;
      }
      const bad = new NamedThrowingService();
      const good = new HealthyService('scheduler');
      supervisor.register(bad);
      supervisor.register(good);

      await supervisor.startAll(makeCtx());
      await vi.advanceTimersByTimeAsync(0); // tick #1
      await vi.advanceTimersByTimeAsync(1_000); // tick #2
      await vi.advanceTimersByTimeAsync(1_000); // tick #3 -> parks

      const health = supervisor.health();
      expect(health[id].state).toBe('parked');
      expect(health[id].consecutiveFailures).toBeGreaterThanOrEqual(3);
      expect(health['scheduler'].state).toBe('running');
      expect(good.ticks).toBeGreaterThanOrEqual(3);

      await supervisor.stopAll();
    });

    it.each(P3_IDS)('%s: a hanging tick is abandoned at the deadline, releasing the in-flight guard for the next tick', async (id) => {
      const supervisor = new ServiceSupervisor({ parkAfterFailures: 100 });
      class NamedHangingService extends HangingService {
        readonly id = id;
      }
      const hanging = new NamedHangingService();
      const good = new HealthyService('scheduler');
      supervisor.register(hanging);
      supervisor.register(good);

      await supervisor.startAll(makeCtx());
      await vi.advanceTimersByTimeAsync(0); // first immediate tick starts, then hangs
      expect(hanging.ticksStarted).toBe(1);

      await vi.advanceTimersByTimeAsync(500); // past the 500ms deadline
      const health = supervisor.health();
      expect(health[id].consecutiveFailures).toBe(1);
      expect(health[id].lastError).toMatch(/deadline/);

      await vi.advanceTimersByTimeAsync(500); // next scheduled tick — proves the guard released
      expect(hanging.ticksStarted).toBe(2);
      expect(good.ticks).toBeGreaterThanOrEqual(1);

      await supervisor.stopAll();
    });
  });

  // Review finding on PR #3037: recordSubsystemOk/Error (daemon-health.ts) are
  // called from inside runTick's own catch block. Before the fix, a health-file
  // write failure there (disk full, permission, or — as simulated here — the
  // state dir replaced with an unwritable path mid-run) would throw OUT of
  // that catch with no further handler, becoming an unhandled rejection that
  // takes the whole daemon down with `process.exit(1)` — reproducing exactly
  // the failure mode this supervisor exists to prevent.
  it('a health-ledger write failure never escapes runTick — the daemon and every sibling survive', async () => {
    // Point AGENTS_DAEMON_DIR at a FILE instead of a directory, so daemon-health's
    // mkdirSync/writeFileSync both fail on every recordSubsystemOk/Error call.
    fs.rmSync(testDaemonDir, { recursive: true, force: true });
    fs.writeFileSync(testDaemonDir, 'not a directory', 'utf-8');

    const supervisor = new ServiceSupervisor({ parkAfterFailures: 3, backoffBaseMs: 5_000, backoffMaxMs: 20_000 });
    const bad = new ThrowingService();
    const healthy = new HealthyService('scheduler');
    supervisor.register(bad);
    supervisor.register(healthy);

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(3_000);

    // The failing service still tracks its own failures correctly...
    expect(bad.ticks).toBeGreaterThan(0);
    expect(supervisor.health()['watchdog'].consecutiveFailures).toBeGreaterThan(0);
    // ...and the healthy sibling was never touched by the other service's
    // health-write failures — this is the actual regression: an escaped throw
    // there would have killed the process before this line ever ran.
    expect(healthy.ticks).toBeGreaterThan(0);
    expect(supervisor.health()['scheduler'].state).toBe('running');

    fs.rmSync(testDaemonDir, { force: true });
  });
});
