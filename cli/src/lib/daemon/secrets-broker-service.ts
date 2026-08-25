/**
 * Secrets-broker lifecycle as a `DaemonService` (RUSH-3193 P2).
 *
 * Wraps the daemon's secrets-broker hosting under the `ServiceSupervisor`
 * contract so the supervisor owns start/stop and reports health through the
 * uniform `daemon-health.ts` path. The broker self-heal (RUSH-1817) is
 * encapsulated here: a background interval re-probes the socket and takes
 * over hosting whenever the daemon is NOT already hosting AND no healthy
 * standalone broker answers a ping.
 */

import { BaseDaemonService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

/** Matches the constant previously in daemon.ts. */
const BROKER_SELF_HEAL_TICK_MS = 60_000;

/** Take over only when we are not already hosting AND no broker is reachable. */
function shouldTakeOver(isHosting: boolean, brokerReachable: boolean): boolean {
  return !isHosting && !brokerReachable;
}

export class SecretsBrokerService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'secrets-broker';

  private hostedBroker: { close(): void } | null = null;
  private selfHealTimer: ReturnType<typeof setInterval> | undefined;
  private selfHealInFlight = false;

  protected async onStart(ctx: DaemonContext): Promise<void> {
    const { agentPing, startHostedBroker } = await import('../secrets/agent.js');
    if ((await agentPing()).reachable) {
      ctx.log('INFO', 'Secrets broker already running (standalone); daemon not hosting it');
    } else {
      this.hostedBroker = await startHostedBroker();
      if (this.hostedBroker) ctx.log('INFO', 'Secrets broker hosted in daemon (socket-first)');
    }

    // RUSH-1817: if the standalone the daemon deferred to at start later dies,
    // take over hosting on the next self-heal probe.
    const runSelfHeal = async (): Promise<void> => {
      if (this.selfHealInFlight) return;
      this.selfHealInFlight = true;
      try {
        const { agentPing: ping, startHostedBroker: startBroker } = await import('../secrets/agent.js');
        const reachable = (await ping()).reachable;
        if (!shouldTakeOver(this.hostedBroker != null, reachable)) return;
        this.hostedBroker = await startBroker();
        if (this.hostedBroker) {
          ctx.log('WARN', 'Secrets broker was unreachable; daemon took over hosting (self-heal)');
        }
      } catch (err) {
        ctx.log('WARN', `Secrets broker self-heal skipped: ${(err as Error).message}`);
      } finally {
        this.selfHealInFlight = false;
      }
    };
    this.selfHealTimer = setInterval(() => { void runSelfHeal(); }, BROKER_SELF_HEAL_TICK_MS);
  }

  protected async onStop(): Promise<void> {
    if (this.selfHealTimer !== undefined) {
      clearInterval(this.selfHealTimer);
      this.selfHealTimer = undefined;
    }
    this.hostedBroker?.close();
    this.hostedBroker = null;
  }
}
