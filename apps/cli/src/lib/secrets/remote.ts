/**
 * Remote secrets — read and use `agents secrets` bundles that live on another
 * host, over the same hardened SSH path that `agents secrets export --host`
 * (the write inverse) already uses.
 *
 * This is the READ / USE direction:
 *   - browse:  drive the remote `agents secrets list|view` and stream its
 *              stdout back verbatim (lossless, no parsing).
 *   - use:     resolve a remote bundle to an env map (JSON over ssh stdout) and
 *              inject it ephemerally — never written to this machine's keychain.
 *
 * Trust model: relies on the operator's existing SSH access to the host (same
 * boundary as `export --host` / `run --host`). Bundle names are shell-quoted
 * into the remote command; resolved VALUES return over ssh stdout; a forwarded
 * file-backend passphrase travels over ssh stdin (first line) so it never lands
 * in argv / `ps` / remote shell history. Nothing is persisted locally.
 */

import { sshExec, sshStream, assertValidSshTarget, type SshExecResult } from '../ssh-exec.js';
import { resolveHost } from '../hosts/registry.js';
import { emitSecretAudit } from './audit.js';
import { sshTargetFor } from '../hosts/types.js';
import { buildRemoteAgentsInvocation } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { isLoaderOrInterpreterEnv } from './bundles.js';

const REMOTE_TIMEOUT_MS = 30_000;

/**
 * Trust boundary for a remote-resolved env map. A peer's `secrets export` output
 * is untrusted input: a compromised or misconfigured host could return keys that
 * silently reshape THIS process's behavior once merged into the agent env
 * (bundles.ts:251 `sanitizeProcessEnv` only strips loader vars from process.env,
 * never the remote bundle). Block the dangerous-override classes here — at the
 * source — so every consumer (`run --secrets b@host`, `secrets exec --host`) is
 * protected, not just one call site:
 *   - LD_* / DYLD_* / NODE_OPTIONS and the other loader/interpreter injections
 *     (reuses the canonical bundles.ts predicate);
 *   - GIT_*        — GIT_SSH_COMMAND et al. hijack every git subprocess;
 *   - *_PROXY      — HTTP(S)_PROXY / ALL_PROXY reroute outbound traffic (MITM);
 *   - *_BASE_URL   — ANTHROPIC_BASE_URL / OPENAI_BASE_URL redirect the model API.
 * These keys are already rejected on the ADD side (validateEnvKey for loaders),
 * so a legitimate bundle never carries them — only a hostile peer would.
 */
export function isDangerousRemoteEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  if (isLoaderOrInterpreterEnv(upper)) return true;
  if (upper.startsWith('GIT_')) return true;
  if (upper.endsWith('_PROXY')) return true;
  if (upper.endsWith('_BASE_URL')) return true;
  return false;
}

/** Remote OS for a host name or target string. Prefer the original host name
 * because enrolled inline hosts resolve to `user@address`, while the OS
 * registry is keyed by the host name. */
function osForTarget(target: string, lookupName?: string): string | undefined {
  const byName = lookupName ? resolveRemoteOsSync(lookupName) : undefined;
  return byName ?? resolveRemoteOsSync(target.split('@').pop() ?? target);
}

/**
 * Resolve a `--host` value to an ssh target STRING for the remote-secrets path.
 * Delegates to the single host/device resolver (`resolveHost`, RUSH-1967) so a
 * name here dials the exact same box `run --host` does; on a miss, treats the
 * value as a raw ssh target and validates it against injection. Named distinctly
 * from `../devices/resolve-target.ts` (which returns richer shapes) so importing
 * the wrong one can't silently change which machine you dial.
 */
export async function resolveHostSshTarget(nameOrAlias: string): Promise<string> {
  const host = await resolveHost(nameOrAlias);
  if (host) return sshTargetFor(host);
  assertValidSshTarget(nameOrAlias);
  return nameOrAlias;
}

/**
 * Merge `--host <single>` / `--hosts <a,b,c>` (and their `--device` / `--devices`
 * aliases) into an ordered, de-duplicated list. All four flags compose; any alone
 * works. `--device`/`--devices` resolve identically to `--host`/`--hosts` so the
 * fleet-wide `--device` vocabulary (see `agents activity`, `agents run --device`)
 * works on the secrets remote commands too. Empty when none is set.
 */
export function parseHostsOption(opts: {
  host?: string;
  hosts?: string;
  device?: string;
  devices?: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (h: string) => {
    const t = h.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  if (opts.host) push(opts.host);
  if (opts.device) push(opts.device);
  if (opts.hosts) for (const h of opts.hosts.split(',')) push(h);
  if (opts.devices) for (const h of opts.devices.split(',')) push(h);
  return out;
}

/**
 * Split a `bundle@host` reference. No `@` → a local bundle (host undefined).
 * Bundle names can't contain `@` (BUNDLE_NAME_PATTERN), so the FIRST `@`
 * separates the bundle from the ssh target — and the target itself may be a
 * `user@host` (e.g. `r2.backups@muqsit@box` → bundle `r2.backups`, host
 * `muqsit@box`).
 */
export function splitBundleRef(ref: string): { bundle: string; host?: string } {
  const at = ref.indexOf('@');
  if (at === -1) return { bundle: ref };
  const bundle = ref.slice(0, at);
  const host = ref.slice(at + 1);
  if (!bundle || !host) {
    throw new Error(`Invalid remote bundle reference ${JSON.stringify(ref)}. Expected 'bundle@host'.`);
  }
  return { bundle, host };
}

/**
 * Run `agents secrets <args>` on a remote host over ssh and return the raw
 * result. Used by the browse commands — the remote's human-readable stdout is
 * streamed back unchanged. `tty` forces an interactive ssh session (`-tt`) so a
 * remote Touch-ID / passphrase prompt can surface (e.g. `view --reveal`).
 */
export function remoteSecretsRaw(
  target: string,
  args: string[],
  opts: { tty?: boolean; input?: string; osLookupName?: string } = {},
): SshExecResult {
  const remoteCmd = buildRemoteAgentsInvocation(['secrets', ...args], undefined, osForTarget(target, opts.osLookupName));
  return sshExec(target, remoteCmd, {
    timeoutMs: REMOTE_TIMEOUT_MS,
    input: opts.input,
    extraSshArgs: opts.tty ? ['-tt'] : undefined,
    multiplex: opts.tty ? false : undefined,
  });
}

/**
 * Run a remote `agents secrets <args>` FOREGROUND, with the local stdio wired
 * straight through (`stdio: 'inherit'` + `-tt`), and return its exit code.
 *
 * Unlike `remoteSecretsRaw` — which pipes stdin, so even with `-tt` the remote
 * process's `process.stdin.isTTY` is false and a passphrase prompt refuses to
 * appear (the macOS file-store guard then hard-errors "needs
 * AGENTS_SECRETS_PASSPHRASE") — this inherits the caller's real terminal, so the
 * remote sees a genuine TTY and its hidden passphrase prompt surfaces and reads
 * the keystrokes. This is the transport for `unlock --host`: you type the remote
 * bundle's passphrase at your own terminal. Output is NOT captured (it streams
 * to the terminal); only the exit code is returned.
 */
export function remoteSecretsStream(target: string, args: string[], opts: { osLookupName?: string } = {}): number {
  const remoteCmd = buildRemoteAgentsInvocation(['secrets', ...args], undefined, osForTarget(target, opts.osLookupName));
  return sshStream(target, remoteCmd, { tty: true });
}

/**
 * Resolve a remote bundle to a plaintext env map by driving the remote's
 * `agents secrets export <bundle> --plaintext --format json`. Values cross over
 * ssh stdout (encrypted in transit), parsed in memory, never persisted.
 *
 * The remote unlocks the bundle with ITS OWN credentials — the owner host's
 * keychain/secrets-agent, or its own `AGENTS_SECRETS_PASSPHRASE` (in the login
 * env) for a file-backed bundle. We deliberately do NOT forward this machine's
 * passphrase: the remote bundle is encrypted with the remote's passphrase, so
 * overriding it would break the read. (A macOS remote under non-interactive
 * SSH will block on Touch-ID — use `view`/`exec` with a remote `file` bundle,
 * an already-unlocked remote secrets-agent, or an interactive `-tt` session.)
 */
export async function remoteResolveEnv(
  target: string,
  bundle: string,
  opts: { osLookupName?: string } = {},
): Promise<Record<string, string>> {
  assertValidSshTarget(target);
  const remoteCmd = buildRemoteAgentsInvocation(
    ['secrets', 'export', bundle, '--plaintext', '--format', 'json'],
    undefined,
    osForTarget(target, opts.osLookupName),
  );
  const res: SshExecResult = sshExec(target, remoteCmd, {
    timeoutMs: REMOTE_TIMEOUT_MS,
  });

  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || '').trim();
    const why = res.timedOut ? 'timed out' : res.code === null ? 'ssh failed' : `exit ${res.code}`;
    throw new Error(`Failed to resolve '${bundle}' on ${target} (${why})${msg ? `: ${msg}` : ''}`);
  }

  // Tolerate login-shell banner noise on stdout: take the outer { … } object.
  const raw = res.stdout;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const jsonText = start >= 0 && end >= start ? raw.slice(start, end + 1) : raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(
      `Could not parse secrets JSON from '${bundle}' on ${target}. ` +
        `Is the remote agents-cli new enough for 'secrets export --format json'?`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Unexpected payload resolving '${bundle}' on ${target}.`);
  }
  const env: Record<string, string> = {};
  const blocked: string[] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // Drop dangerous-override keys returned by the (untrusted) peer before they
    // can reshape this process — see isDangerousRemoteEnvKey.
    if (isDangerousRemoteEnvKey(k)) {
      blocked.push(k);
      continue;
    }
    env[k] = typeof v === 'string' ? v : String(v);
  }
  if (blocked.length > 0) {
    process.stderr.write(
      `[secrets] Dropped ${blocked.length} dangerous key(s) from '${bundle}'@${target} ` +
        `(remote override blocked): ${blocked.join(', ')}\n`,
    );
  }
  // The remote host audits its own `secrets export` read; this emit records the
  // event on the INITIATING host too (values were pulled into this process and
  // injected locally). Covers `secrets exec --host` and `run --secrets b@host`.
  // Values never enter the payload — only the bundle, target host, and count.
  emitSecretAudit({
    event: 'secrets.get',
    bundle,
    operation: 'remote resolve',
    source: 'remote',
    host: target,
    status: 'success',
    keyCount: Object.keys(env).length,
  });
  return env;
}

/**
 * Outcome of a post-push read-back verification (see verifyRemoteKeychainPush).
 *   - `ok`               — the pushed keys materialized readably on the remote.
 *   - `locked-keychain`  — the read-back gave the SPECIFIC signal of a keychain
 *                          that didn't persist (the remote's headless "not unlocked
 *                          in the secrets agent" guard, or a "stored item … not
 *                          found" on read-back, or pushed keys simply absent). Only
 *                          this verdict earns the locked-login-keychain diagnosis +
 *                          `--remote-backend file` steer.
 *   - `error`            — a DIFFERENT failure (flaky SSH, timeout, unparseable
 *                          payload). The raw error is re-surfaced verbatim, never
 *                          mislabeled as a locked keychain.
 */
export type RemoteKeychainWriteVerification =
  | { ok: true }
  | { ok: false; kind: 'locked-keychain'; reason: string }
  | { ok: false; kind: 'error'; reason: string };

/**
 * The remote's headless read-back raises one of these when a keychain-backed bundle
 * has metadata but no readable value items — the exact locked-login-keychain
 * signature. Anything else (connection refused, timeout, host key error) is a
 * transient/unrelated failure and must NOT be mislabeled as a locked keychain.
 */
function isLockedKeychainReadBackError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    // bundles.ts agentOnly guard: "…is not unlocked in the secrets agent…"
    s.includes('not unlocked') ||
    s.includes('secrets agent') ||
    // resolveBundleEnv: "Bundle '<b>' key '<k>': stored item '<item>' not found."
    s.includes('stored item') ||
    s.includes('not found')
  );
}

/**
 * Decide whether a keychain-backed push to a remote actually PERSISTED its secret
 * value items, given the read-back of that bundle from the remote's own store.
 *
 * The silent-failure this guards: pushing `--remote-backend keychain` (default) to
 * a macOS host over headless SSH lands the bundle METADATA but not readable value
 * items — the remote login keychain is locked in the non-interactive SSH context,
 * so Security accepts the item WRITE at the DB level but the biometry-ACL'd item is
 * unreadable, and the remote `import` still reports success (values written first,
 * metadata `noAcl` last — bundles.ts writeBundleWithItems). The metadata-only bundle
 * then fails every later read with the confusing `Bundle '<b>' key '<k>': stored
 * item '<item>' not found` (bundles.ts resolveBundleEnv). We catch it by reading
 * the bundle back the same way a release will (`secrets export --plaintext --format
 * json`, driven headlessly on the remote so its `agentOnly` guard FAILS FAST before
 * any keychain read — no Touch ID prompt) and confirming every pushed key returned.
 *
 * Pure so both branches are unit-testable without a real locked keychain: inject the
 * "read-back failed / key absent" condition through `readBack`.
 */
export function evaluateKeychainWriteVerification(
  pushedKeys: string[],
  readBack:
    | { ok: true; keys: string[] }
    | { ok: false; stderr: string },
): RemoteKeychainWriteVerification {
  if (!readBack.ok) {
    const stderr = readBack.stderr.trim();
    if (isLockedKeychainReadBackError(stderr)) {
      // The remote's own headless read raised the not-unlocked / not-found signal —
      // exactly the confusing error the user hits later. Surface it now, at push
      // time, with the fix.
      return {
        ok: false,
        kind: 'locked-keychain',
        reason: `the remote could not read it back${stderr ? ` (${stderr})` : ''}`,
      };
    }
    // A transient / unrelated failure (flaky SSH, timeout, bad payload). Re-surface
    // verbatim — do NOT diagnose a locked keychain from a connection error.
    return {
      ok: false,
      kind: 'error',
      reason: stderr || 'read-back failed',
    };
  }
  const present = new Set(readBack.keys);
  const missing = pushedKeys.filter((k) => !present.has(k));
  if (missing.length > 0) {
    // Read-back succeeded but some pushed keys are absent — the value items didn't
    // persist. Same locked-keychain cause and fix.
    return {
      ok: false,
      kind: 'locked-keychain',
      reason:
        `${missing.length} of ${pushedKeys.length} key(s) did not persist on the remote ` +
        `(missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})`,
    };
  }
  return { ok: true };
}

/**
 * The actionable error message for a failed keychain-over-SSH push verification.
 * Names the cause (locked remote login keychain) and steers to the two real fixes:
 * re-run with the headless-readable file backend, or unlock the remote keychain.
 * Pure + exported so the exact guidance is asserted in tests.
 */
export function keychainWriteFailureMessage(
  host: string,
  bundle: string,
  reason: string,
): string {
  return (
    `${host}: pushed '${bundle}' but the keychain items did not persist — ${reason}. ` +
    `A macOS login keychain is LOCKED under headless SSH, so a keychain-backed write ` +
    `lands the bundle metadata but no readable secret items, and later reads fail with ` +
    `"stored item '…' not found". Re-run with a headless-readable backend:\n` +
    `    agents secrets export ${bundle} --host ${host} --remote-backend file\n` +
    `(needs AGENTS_SECRETS_PASSPHRASE set locally), or unlock the remote keychain first ` +
    `(e.g. an interactive login / \`agents secrets unlock\` on ${host}) and retry.`
  );
}

/**
 * Read a bundle back from a remote over SSH (headlessly, so it fails fast rather
 * than prompting Touch ID) and confirm the pushed keys materialized. Drives the
 * remote's own `secrets export <bundle> --plaintext --format json` — the same read
 * a headless release performs — but keeps only the KEY NAMES; the plaintext values
 * are dropped immediately and never retained or logged. Returns a verification
 * verdict; the caller renders `keychainWriteFailureMessage` on failure.
 */
export function verifyRemoteKeychainPush(
  target: string,
  bundle: string,
  pushedKeys: string[],
  opts: { osLookupName?: string } = {},
): RemoteKeychainWriteVerification {
  const remoteCmd = buildRemoteAgentsInvocation(
    ['secrets', 'export', bundle, '--plaintext', '--format', 'json'],
    undefined,
    osForTarget(target, opts.osLookupName),
  );
  const res: SshExecResult = sshExec(target, remoteCmd, { timeoutMs: REMOTE_TIMEOUT_MS });
  if (res.code !== 0) {
    const why = res.timedOut ? 'timed out' : res.code === null ? 'ssh failed' : `exit ${res.code}`;
    const stderr = `${why}${(res.stderr || res.stdout || '').trim() ? `: ${(res.stderr || res.stdout).trim()}` : ''}`;
    return evaluateKeychainWriteVerification(pushedKeys, { ok: false, stderr });
  }
  // Take the outer { … } object (tolerate login-shell banner noise), read the key
  // names, and immediately discard the values — we only need presence here.
  const raw = res.stdout;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const jsonText = start >= 0 && end >= start ? raw.slice(start, end + 1) : raw.trim();
  let keys: string[];
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return evaluateKeychainWriteVerification(pushedKeys, {
        ok: false,
        stderr: 'unexpected read-back payload',
      });
    }
    keys = Object.keys(parsed as Record<string, unknown>);
  } catch {
    return evaluateKeychainWriteVerification(pushedKeys, {
      ok: false,
      stderr: 'could not parse read-back JSON',
    });
  }
  return evaluateKeychainWriteVerification(pushedKeys, { ok: true, keys });
}
