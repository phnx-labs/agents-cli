import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FairScheduler } from './fairness';
import { validateRequestShape } from './isolation';
import { ciLayout, resultPath, worktreePath, type CiLayout } from './paths';
import {
  DEFAULT_CAPACITY,
  emptyTimings,
  type Capacity,
  type ExecutorRequest,
  type RunRecord,
} from './types';

export interface BrokerOptions {
  layout?: CiLayout;
  capacity?: Capacity;
  now?: () => number;
}

/**
 * Shared no-lease broker. A submit is a request for admission to a standing
 * Crabbox — never a box lease or a caller-chosen checkout.
 */
export class Broker {
  readonly layout: CiLayout;
  readonly scheduler: FairScheduler;
  private readonly now: () => number;

  constructor(opts: BrokerOptions = {}) {
    this.layout = opts.layout ?? ciLayout();
    this.scheduler = new FairScheduler(opts.capacity ?? DEFAULT_CAPACITY);
    this.now = opts.now ?? Date.now;
    mkdirSync(this.layout.state, { recursive: true });
  }

  submit(raw: Record<string, unknown>): RunRecord {
    const request = validateRequestShape(raw);
    const runId = request.checkRunId;
    const existing = this.tryRead(runId);
    if (existing) {
      throw new Error(`run ${runId} already exists with status ${existing.status}`);
    }

    const record: RunRecord = {
      runId,
      request,
      status: 'queued',
      worktreePath: worktreePath(this.layout, request),
      resultPath: resultPath(this.layout, request.owner, request.repo, runId),
      timings: emptyTimings(this.now()),
    };

    const decision = this.scheduler.canAdmit(request.owner, request.repo, request.resourceClass);
    if (decision.admit) {
      record.status = 'admitted';
      record.timings.admittedAtMs = this.now();
      this.scheduler.markRunning(record);
    } else {
      this.scheduler.enqueue(record);
    }

    this.write(record);
    return record;
  }

  drain(): RunRecord[] {
    const admitted: RunRecord[] = [];
    let next = this.scheduler.nextEligible();
    while (next) {
      const record = this.read(next.runId);
      record.status = 'admitted';
      record.timings.admittedAtMs = this.now();
      this.scheduler.markRunning(record);
      this.write(record);
      admitted.push(record);
      next = this.scheduler.nextEligible();
    }
    return admitted;
  }

  complete(runId: string, status: 'succeeded' | 'failed', extra: Partial<RunRecord> = {}): RunRecord {
    const record = this.read(runId);
    record.status = status;
    Object.assign(record, extra);
    this.scheduler.complete(runId);
    this.write(record);
    this.drain();
    return record;
  }

  read(runId: string): RunRecord {
    const record = this.tryRead(runId);
    if (!record) throw new Error(`unknown run ${runId}`);
    return record;
  }

  tryRead(runId: string): RunRecord | null {
    const file = this.recordPath(runId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
  }

  private recordPath(runId: string): string {
    return join(this.layout.state, 'runs', `${runId}.json`);
  }

  private write(record: RunRecord): void {
    const file = this.recordPath(record.runId);
    mkdirSync(join(this.layout.state, 'runs'), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2));
  }
}

export function requestFromUnknown(input: unknown): ExecutorRequest {
  if (!input || typeof input !== 'object') throw new Error('executor request must be an object');
  return validateRequestShape(input as Record<string, unknown>);
}
