/**
 * Cron-based job scheduler for routines.
 *
 * Wraps the croner library to manage scheduled jobs in-memory. The daemon
 * process creates a single JobScheduler instance that loads enabled jobs
 * on startup and reloads them on SIGHUP.
 */

import { Cron } from 'croner';
import type { JobConfig } from './routines.js';
import { listJobs, deleteJob, isPastEndAt, setJobEnabled } from './routines.js';

/** A job config paired with its active cron instance. */
interface ScheduledJob {
  config: JobConfig;
  cron: Cron;
}

/** In-memory cron scheduler that triggers a callback when jobs fire. */
export class JobScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private onTrigger: (config: JobConfig) => Promise<void>;

  constructor(onTrigger: (config: JobConfig) => Promise<void>) {
    this.onTrigger = onTrigger;
  }

  loadAll(): void {
    const configs = listJobs();
    for (const config of configs) {
      // Trigger-only jobs (no cron schedule) fire via the webhook receiver,
      // not the cron loop — skip them here.
      if (config.enabled && config.schedule) {
        this.schedule(config);
      }
    }
  }

  schedule(config: JobConfig): void {
    // A schedule-less (trigger-only) job has nothing to hand to croner.
    if (!config.schedule) return;
    this.unschedule(config.name);

    // catch: true — a throw from one job's callback should not kill the
    // whole cron loop. Each invocation of onTrigger is already wrapped in
    // try/catch, but a synchronous throw before the await would otherwise
    // bubble up; defense in depth.
    const cronOptions: Record<string, unknown> = { catch: true };
    if (config.timezone) cronOptions.timezone = config.timezone;

    const cron = new Cron(config.schedule, cronOptions, async () => {
      // endAt: once the configured end time has passed, auto-disable and stop
      // firing. We persist enabled=false to disk so the next daemon reload
      // doesn't re-schedule, and unschedule in-memory so this cron stops.
      if (isPastEndAt(config)) {
        this.unschedule(config.name);
        try {
          setJobEnabled(config.name, false);
        } catch (err) {
          console.error(`Job '${config.name}' endAt auto-disable failed:`, (err as Error).message);
        }
        console.log(`Job '${config.name}' reached endAt (${config.endAt}); auto-disabled.`);
        return;
      }

      try {
        await this.onTrigger(config);
      } catch (err) {
        console.error(`Job '${config.name}' failed:`, (err as Error).message);
      }

      // One-shot jobs: remove after first execution
      if (config.runOnce) {
        this.unschedule(config.name);
        deleteJob(config.name);
      }
    });

    this.jobs.set(config.name, { config, cron });
  }

  unschedule(name: string): void {
    const existing = this.jobs.get(name);
    if (existing) {
      existing.cron.stop();
      this.jobs.delete(name);
    }
  }

  reloadAll(): void {
    this.stopAll();
    this.loadAll();
  }

  stopAll(): void {
    for (const [, job] of this.jobs) {
      job.cron.stop();
    }
    this.jobs.clear();
  }

  getNextRun(name: string): Date | null {
    const job = this.jobs.get(name);
    if (!job) return null;
    return job.cron.nextRun() || null;
  }

  listScheduled(): Array<{ name: string; nextRun: Date | null; enabled: boolean }> {
    const result: Array<{ name: string; nextRun: Date | null; enabled: boolean }> = [];
    for (const [name, job] of this.jobs) {
      result.push({
        name,
        nextRun: job.cron.nextRun() || null,
        enabled: job.config.enabled,
      });
    }
    return result;
  }
}
