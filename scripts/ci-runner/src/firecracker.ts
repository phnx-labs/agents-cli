import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { warmSnapshotPath, type CiLayout } from './paths';
import { assertMounts } from './isolation';

export interface VmMount {
  source: string;
  target: string;
  writable: boolean;
}

export interface VmRecord {
  id: string;
  snapshot: string;
  mounts: VmMount[];
  destroyed: boolean;
  started: boolean;
}

/**
 * Warm one-use Firecracker lifecycle.
 *
 * The host never hands out a long-lived VM. Restore a warm snapshot, run
 * once, destroy. Re-starting the same id is a bug.
 */
export class FirecrackerPool {
  constructor(private readonly layout: CiLayout) {
    mkdirSync(warmSnapshotPath(layout), { recursive: true });
    const marker = join(warmSnapshotPath(layout), '.warm');
    if (!existsSync(marker)) writeFileSync(marker, 'warm-snapshot\n');
  }

  private vmDir(id: string): string {
    return join(this.layout.snapshots, 'vms', id);
  }

  restore(id: string, mounts: VmMount[]): VmRecord {
    if (existsSync(this.vmDir(id))) {
      throw new Error(`Firecracker vm ${id} already exists; one-use ids cannot be restored twice`);
    }
    assertMounts(mounts.map((mount) => mount.source));
    const worktrees = mounts.filter((mount) => mount.writable);
    const caches = mounts.filter((mount) => !mount.writable);
    if (worktrees.length !== 1) {
      throw new Error('one-use vm must mount exactly one writable worktree');
    }
    if (caches.some((mount) => mount.writable)) {
      throw new Error('cache mounts must be read-only');
    }
    mkdirSync(this.vmDir(id), { recursive: true });
    const record: VmRecord = {
      id,
      snapshot: warmSnapshotPath(this.layout),
      mounts,
      destroyed: false,
      started: false,
    };
    writeFileSync(join(this.vmDir(id), 'vm.json'), JSON.stringify(record, null, 2));
    return record;
  }

  start(id: string): VmRecord {
    const record = this.read(id);
    if (record.destroyed) throw new Error(`cannot start destroyed vm ${id}`);
    if (record.started) throw new Error(`vm ${id} is one-use and already started`);
    record.started = true;
    writeFileSync(join(this.vmDir(id), 'vm.json'), JSON.stringify(record, null, 2));
    return record;
  }

  destroy(id: string): void {
    const dir = this.vmDir(id);
    if (!existsSync(dir)) return;
    const record = this.read(id);
    record.destroyed = true;
    writeFileSync(join(dir, 'vm.json'), JSON.stringify(record, null, 2));
    rmSync(dir, { recursive: true, force: true });
  }

  read(id: string): VmRecord {
    const file = join(this.vmDir(id), 'vm.json');
    if (!existsSync(file)) throw new Error(`vm ${id} does not exist`);
    return JSON.parse(readFileSync(file, 'utf8')) as VmRecord;
  }

  exists(id: string): boolean {
    return existsSync(join(this.vmDir(id), 'vm.json'));
  }
}
