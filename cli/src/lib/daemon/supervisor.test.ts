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
  ticks = 0;
  started = false;
  stopped = false;

  constructor(id: DaemonServiceId) {
    this.id = id;
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
});
