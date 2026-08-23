// PR board mutation only. Status is projected by `agents feed watch --json`;
// this module never starts a second GitHub status poller.

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);


/**
 * Merge a PR from the board. Plain `gh pr merge --rebase` — deliberately NO
 * --admin (branch protection stays in force) and no fallback strategy; the board
 * only offers the button on readyToMerge (approved + green + mergeable), so a
 * refusal here is a real signal surfaced back to the UI, not something to bypass.
 */
export async function mergePr(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execAsync(`gh pr merge ${JSON.stringify(url)} --rebase`, { timeout: 30_000 });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // gh prints the useful reason on stderr, which exec folds into the message.
    return { ok: false, error: msg.slice(0, 400) };
  }
}
