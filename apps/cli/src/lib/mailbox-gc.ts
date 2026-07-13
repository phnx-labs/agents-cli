/**
 * Mailbox liveness sweep and GC.
 *
 * A box whose owning agent is no longer alive is a ghost: pending messages will
 * never be drained, and any feed block tied to that box is stale. This module
 * archives dead-box messages and prunes old consumed entries so the spool stays
 * bounded under fleet load.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getMailboxRootDir } from './state.js';
import {
  mailboxDir,
  isValidMailboxId,
  readMessage,
  type MailboxMessage,
} from './mailbox.js';
import { listBlocks, removeBlock } from './feed.js';

export interface GcResult {
  boxesScanned: number;
  deadBoxes: number;
  messagesDroppedExpired: number;
  messagesDroppedDead: number;
  consumedPruned: number;
  blocksRemoved: number;
}

export interface GcOptions {
  root?: string;
  /** Feed store root. Defaults to getFeedDir(). */
  feedRoot?: string;
  now?: Date;
  /** Age in minutes after which consumed entries are pruned. Default 24h. */
  maxConsumedAgeMinutes?: number;
}

const DEFAULT_MAX_CONSUMED_AGE_MINUTES = 24 * 60;

function consumedAgeMinutes(file: string, now: Date): number {
  try {
    const stat = fs.statSync(file);
    return (now.getTime() - stat.mtimeMs) / 60_000;
  } catch {
    return 0;
  }
}

function jsonFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).sort();
}

function archiveAllPending(boxDir: string, reason: string): number {
  let n = 0;
  for (const dir of [path.join(boxDir, 'inbox'), path.join(boxDir, 'processing')]) {
    for (const name of jsonFiles(dir)) {
      const src = path.join(dir, name);
      const dest = path.join(boxDir, 'consumed', name);
      try {
        const msg = readMessage(src);
        if (msg) {
          msg.dropped = reason;
          const tmp = `${dest}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(msg, null, 2), 'utf-8');
          fs.renameSync(tmp, dest);
          fs.unlinkSync(src);
        } else {
          fs.renameSync(src, dest);
        }
        n++;
      } catch {
        // ignore racing writers
      }
    }
  }
  return n;
}

function pruneConsumed(boxDir: string, maxAgeMinutes: number, now: Date): number {
  let n = 0;
  const consumed = path.join(boxDir, 'consumed');
  for (const name of jsonFiles(consumed)) {
    const file = path.join(consumed, name);
    if (consumedAgeMinutes(file, now) >= maxAgeMinutes) {
      try {
        fs.unlinkSync(file);
        n++;
      } catch {
        // ignore
      }
    }
  }
  return n;
}

/**
 * Sweep all mailboxes. For dead boxes (not in `activeBoxIds`), archive every
 * pending message as `dropped: dead` and remove any feed block tied to that
 * mailbox. For live boxes, drop expired messages and prune old consumed files.
 */
export function gcMailbox(
  activeBoxIds: Set<string>,
  options: GcOptions = {},
): GcResult {
  const root = options.root ?? getMailboxRootDir();
  const feedRoot = options.feedRoot;
  const now = options.now ?? new Date();
  const maxConsumedAgeMinutes = options.maxConsumedAgeMinutes ?? DEFAULT_MAX_CONSUMED_AGE_MINUTES;

  const result: GcResult = {
    boxesScanned: 0,
    deadBoxes: 0,
    messagesDroppedExpired: 0,
    messagesDroppedDead: 0,
    consumedPruned: 0,
    blocksRemoved: 0,
  };

  let boxNames: string[];
  try {
    boxNames = fs.readdirSync(root);
  } catch {
    return result;
  }

  // Pre-compute dead blocks so we remove each once, regardless of how many
  // messages reference it.
  const blocksToRemove = new Set<string>();
  for (const block of listBlocks(feedRoot)) {
    if (!activeBoxIds.has(block.mailboxId)) {
      blocksToRemove.add(block.blockId);
    }
  }

  for (const name of boxNames) {
    if (!isValidMailboxId(name)) continue;
    result.boxesScanned++;
    const boxDir = mailboxDir(name, root);

    if (!activeBoxIds.has(name)) {
      result.deadBoxes++;
      result.messagesDroppedDead += archiveAllPending(boxDir, 'dead');
      result.consumedPruned += pruneConsumed(boxDir, maxConsumedAgeMinutes, now);
      // Also prune the empty box dir if it is now empty.
      try {
        for (const sub of ['inbox', 'processing', 'consumed']) {
          const subdir = path.join(boxDir, sub);
          if (fs.existsSync(subdir) && fs.readdirSync(subdir).length === 0) {
            fs.rmdirSync(subdir);
          }
        }
        if (fs.existsSync(boxDir) && fs.readdirSync(boxDir).length === 0) {
          fs.rmdirSync(boxDir);
        }
      } catch {
        // ignore
      }
    } else {
      // Live box: lazy expiry is handled by drain/peek, but sweep here for GC metrics.
      // We still need to read expired messages; reuse readMessage directly to avoid
      // importing sweepExpired and duplicating logic.
      for (const sub of ['inbox', 'processing']) {
        const dir = path.join(boxDir, sub);
        for (const file of jsonFiles(dir)) {
          const msg = readMessage(path.join(dir, file));
          if (msg && msg.expiresAt) {
            const ts = Date.parse(msg.expiresAt);
            if (!Number.isNaN(ts) && ts <= now.getTime()) {
              result.messagesDroppedExpired++;
            }
          }
        }
      }
      result.consumedPruned += pruneConsumed(boxDir, maxConsumedAgeMinutes, now);
    }
  }

  for (const blockId of blocksToRemove) {
    if (removeBlock(blockId, feedRoot)) {
      result.blocksRemoved++;
    }
  }

  return result;
}
