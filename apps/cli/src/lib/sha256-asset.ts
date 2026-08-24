/**
 * sha256 helpers for verifying downloaded release assets.
 *
 * These live in their own LEAF module — importing only `node:crypto` and
 * `node:fs` — on purpose. They used to sit in `computer/ssh-tunnel.ts`, whose
 * own import graph reaches `browser/drivers/ssh.ts` -> `browser/chrome.ts` ->
 * `secrets/*`. `helper-download.ts` needs nothing from that graph but these two
 * pure functions, and importing them from there closed a module-initialization
 * cycle:
 *
 *   helper-download.ts
 *     -> computer/ssh-tunnel.ts        (evaluated BEFORE `EXPECTED_TEAM_ID`)
 *       -> browser/drivers/ssh.ts -> browser/chrome.ts
 *         -> secrets/bundles.ts -> secrets/index.ts -> secrets/install-helper.ts
 *           -> secrets/download-keychain.ts
 *             -> helper-download.ts    (still evaluating; const not yet bound)
 *
 * which threw `ReferenceError: Cannot access 'EXPECTED_TEAM_ID' before
 * initialization` at `secrets/download-keychain.ts:45` for any entry point that
 * reached `helper-download.ts` first (RUSH-3113). Keep this module a leaf: adding
 * a local import here can reintroduce that cycle.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

/** Pull the digest out of a `<sha256>  <filename>` release asset. */
export function parseSha256Asset(text: string): string {
  const m = text.trim().match(/^([A-Fa-f0-9]{64})(\s|$)/);
  if (!m) throw new Error(`malformed .sha256 release asset: ${JSON.stringify(text.slice(0, 80))}`);
  return m[1].toLowerCase();
}

/** Stream a file through sha256 — the exe is ~157MB, never read it whole. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
