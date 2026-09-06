/**
 * Remote secrets — read and use `agents secrets` bundles that live on another
 * host over the same SSH path that `agents secrets export --device` uses.
 *
 * Browse streams remote stdout verbatim; use resolves a bundle to an env map
 * and injects it ephemerally without persisting it locally.
 */

import { sshExec, sshExecAsync, sshStream, assertValidSshTarget, shellQuote, type SshExecResult } from '../ssh-exec.js';
import { emitSecretAudit } from './audit.js';
import { buildRemoteAgentsInvocation } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { isLoaderOrInterpreterEnv } from './bundles.js';
import { isHostPinned, hostKeyCheckingOpts } from '../devices/known-hosts.js';
import { assertCredentialTransportHostPinned, hostKeyLookupName, resolveHostSshTarget } from '../hosts/credential-transport.js';

// The host-pinning guard and the `--device` → ssh-target resolver are agents
// fleet policy and live in `hosts/credential-transport.ts` (PHNX-3989); they are
// re-exported here only for the consumers not yet converted off this module.
export { assertCredentialTransportHostPinned, resolveHostSshTarget };

export const REMOTE_TIMEOUT_MS = 30_000;

export interface RemoteSecretsRawOptions {
  tty?: boolean;
  input?: string;
  osLookupName?: string;
  secret?: boolean;
  timeoutMs?: number;
}

/**
 * SSH options for secret-carrying transport. Pins the managed host key and
 * disables multiplex so no reusable control socket lingers for other invocations.
 */
export function credentialTransportSshOpts(target: string): { hostKeyOpts: string[]; multiplex: false } {
  return { hostKeyOpts: hostKeyCheckingOpts(isHostPinned(hostKeyLookupName(target))), multiplex: false };
}

/**
 * Trust boundary for a remote-resolved env map. A peer's export output is
 * untrusted input that could reshape this process once merged into the env, so
 * block dangerous override classes here for every consumer:
 * loader/interpreter vars, GIT_*, *_PROXY, and *_BASE_URL.
 */
export function isDangerousRemoteEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  if (isLoaderOrInterpreterEnv(upper)) return true;
  if (upper.startsWith('GIT_')) return true; // GIT_SSH_COMMAND hijacks git subprocesses
  if (upper.endsWith('_PROXY')) return true; // *_PROXY = MITM
  if (upper.endsWith('_BASE_URL')) return true; // *_BASE_URL = model API redirect
  return false;
}

/** Remote OS for a host name or target string. Prefer the original host name
 *  because enrolled inline hosts resolve to `user@address`, while the OS
 *  registry is keyed by the host name. */
function osForTarget(target: string, lookupName?: string): string | undefined {
  const byName = lookupName ? resolveRemoteOsSync(lookupName) : undefined;
  return byName ?? resolveRemoteOsSync(target.split('@').pop() ?? target);
}

/**
 * Merge `--host` / `--hosts` (and their `--device` / `--devices` aliases) into
 * an ordered, de-duplicated list. Empty when none is set.
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
 * Split a `bundle@host` reference. No `@` → a local bundle. Bundle names can't
 * contain `@`, so the FIRST `@` separates bundle from ssh target; the target
 * itself may be `user@host` (e.g. `r2.backups@muqsit@box`).
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
 * result. Used by browse commands; `tty` forces `-tt` so remote passphrase
 * prompts can surface.
 */
export function remoteSecretsRaw(
  target: string,
  args: string[],
  opts: RemoteSecretsRawOptions = {},
): SshExecResult {
  const remoteCmd = buildRemoteAgentsInvocation(['secrets', ...args], undefined, osForTarget(target, opts.osLookupName));
  // `secret: true` pins the managed host key and refuses multiplex; `-tt`
  // additionally allocates a PTY and never multiplexes. The two compose.
  const posture = opts.secret ? credentialTransportSshOpts(target) : {};
  const conn = opts.tty
    ? { ...posture, extraSshArgs: ['-tt'], multiplex: false as const }
    : posture;
  return sshExec(target, remoteCmd, {
    timeoutMs: opts.timeoutMs ?? REMOTE_TIMEOUT_MS,
    input: opts.input,
    ...conn,
  });
}

/** Async, kill-bounded inverse of {@link remoteSecretsRaw} for daemon callers. */
export function remoteSecretsRawAsync(
  target: string,
  args: string[],
  opts: RemoteSecretsRawOptions = {},
): Promise<SshExecResult> {
  const remoteCmd = buildRemoteAgentsInvocation(['secrets', ...args], undefined, osForTarget(target, opts.osLookupName));
  const posture = opts.secret ? credentialTransportSshOpts(target) : {};
  const conn = opts.tty
    ? { ...posture, extraSshArgs: ['-tt'], multiplex: false as const }
    : posture;
  return sshExecAsync(target, remoteCmd, {
    timeoutMs: opts.timeoutMs ?? REMOTE_TIMEOUT_MS,
    input: opts.input,
    ...conn,
  });
}

/**
 * Run a remote `agents secrets <args>` foreground with local stdio inherited,
 * so the remote sees a real TTY and its passphrase prompt surfaces and reads
 * keystrokes. Output streams to the terminal; only the exit code is returned.
 */
export function remoteSecretsStream(target: string, args: string[], opts: { osLookupName?: string } = {}): number {
  const remoteCmd = buildRemoteAgentsInvocation(['secrets', ...args], undefined, osForTarget(target, opts.osLookupName));
  return sshStream(target, remoteCmd, { tty: true, ...credentialTransportSshOpts(target) });
}

/**
 * Resolve a remote bundle to a plaintext env map by driving the remote's
 * `agents secrets export <bundle> --plaintext --format json`. Values cross over
 * ssh stdout, parsed in memory, never persisted.
 *
 * The remote unlocks the bundle with its own credentials; this machine does NOT
 * forward its passphrase because the remote bundle is encrypted with the
 * remote's passphrase.
 */
export async function remoteResolveEnv(
  target: string,
  bundle: string,
  opts: { osLookupName?: string } = {},
): Promise<Record<string, string>> {
  assertValidSshTarget(target);
  // AGENTS_SECRETS_REMOTE_TRANSPORT marks this as the machine-to-machine JSON
  // resolve path (the public shell-eval export mode was removed).
  const remoteCmd = buildRemoteAgentsInvocation(
    ['secrets', 'export', bundle, '--plaintext', '--format', 'json'],
    undefined,
    osForTarget(target, opts.osLookupName),
    { AGENTS_SECRETS_REMOTE_TRANSPORT: '1' },
  );
  const res: SshExecResult = sshExec(target, remoteCmd, {
    timeoutMs: REMOTE_TIMEOUT_MS,
    ...credentialTransportSshOpts(target),
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
    // Drop dangerous-override keys returned by the (untrusted) peer.
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
  // Audit the event on the initiating host too; values never enter the payload.
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
 * Outcome of a post-push read-back verification.
 *   - `ok`              — the pushed keys materialized readably.
 *   - `locked-keychain` — read-back gave the specific locked-keychain signal.
 *   - `error`           — a different failure (SSH, timeout, etc.).
 */
export type RemoteKeychainWriteVerification =
  | { ok: true }
  | { ok: false; kind: 'locked-keychain'; reason: string }
  | { ok: false; kind: 'error'; reason: string };

/**
 * True when the remote's headless read-back raised the locked-login-keychain
 * signature. Anything else must NOT be mislabeled as a locked keychain.
 */
function isLockedKeychainReadBackError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('not unlocked') ||
    s.includes('secrets agent') ||
    s.includes('stored item') ||
    s.includes('not found')
  );
}

/**
 * Decide whether a keychain-backed push to a remote actually persisted its
 * secret value items by reading the bundle back the same way a later resolve
 * will. Catches the silent failure where headless SSH writes metadata but not
 * readable value items to a locked macOS login keychain.
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
      return {
        ok: false,
        kind: 'locked-keychain',
        reason: `the remote could not read it back${stderr ? ` (${stderr})` : ''}`,
      };
    }
    return {
      ok: false,
      kind: 'error',
      reason: stderr || 'read-back failed',
    };
  }
  const present = new Set(readBack.keys);
  const missing = pushedKeys.filter((k) => !present.has(k));
  if (missing.length > 0) {
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
 * Actionable error message for a failed keychain-over-SSH push. Names the cause
 * (locked remote login keychain) and steers to the two real fixes.
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
    `    agents secrets export ${bundle} --device ${host} --remote-backend file\n` +
    `(needs AGENTS_SECRETS_PASSPHRASE set locally), or unlock the remote keychain first ` +
    `(e.g. an interactive login / \`agents secrets unlock\` on ${host}) and retry.`
  );
}

/**
 * Read a bundle back from a remote over SSH and confirm the pushed keys
 * materialized. Drives the marker-gated json transport but keeps only KEY NAMES;
 * plaintext values are discarded immediately. Returns a verification verdict.
 */
export function verifyRemoteKeychainPush(
  target: string,
  bundle: string,
  pushedKeys: string[],
  opts: { osLookupName?: string; secret?: boolean; timeoutMs?: number } = {},
): RemoteKeychainWriteVerification {
  const remoteCmd = buildRemoteAgentsInvocation(
    ['secrets', 'export', bundle, '--plaintext', '--format', 'json'],
    undefined,
    osForTarget(target, opts.osLookupName),
    { AGENTS_SECRETS_REMOTE_TRANSPORT: '1' },
  );
  const res: SshExecResult = sshExec(target, remoteCmd, {
    timeoutMs: opts.timeoutMs ?? REMOTE_TIMEOUT_MS,
    ...(opts.secret ? credentialTransportSshOpts(target) : {}),
  });
  return evaluateRemoteKeychainPushResult(pushedKeys, res);
}

/** Async, kill-bounded read-back verification for daemon-originated pushes. */
export async function verifyRemoteKeychainPushAsync(
  target: string,
  bundle: string,
  pushedKeys: string[],
  opts: { osLookupName?: string; secret?: boolean; timeoutMs?: number } = {},
): Promise<RemoteKeychainWriteVerification> {
  const remoteCmd = buildRemoteAgentsInvocation(
    ['secrets', 'export', bundle, '--plaintext', '--format', 'json'],
    undefined,
    osForTarget(target, opts.osLookupName),
    { AGENTS_SECRETS_REMOTE_TRANSPORT: '1' },
  );
  const res = await sshExecAsync(target, remoteCmd, {
    timeoutMs: opts.timeoutMs ?? REMOTE_TIMEOUT_MS,
    ...(opts.secret ? credentialTransportSshOpts(target) : {}),
  });
  return evaluateRemoteKeychainPushResult(pushedKeys, res);
}

function evaluateRemoteKeychainPushResult(
  pushedKeys: string[],
  res: SshExecResult,
): RemoteKeychainWriteVerification {
  if (res.code !== 0) {
    const why = res.timedOut ? 'timed out' : res.code === null ? 'ssh failed' : `exit ${res.code}`;
    const stderr = `${why}${(res.stderr || res.stdout || '').trim() ? `: ${(res.stderr || res.stdout).trim()}` : ''}`;
    return evaluateKeychainWriteVerification(pushedKeys, { ok: false, stderr });
  }
  // Tolerate login-shell banner noise; keep only key names and discard values.
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

/**
 * `bash -lc` command + stdin payload for a file-backed remote import.
 *
 * The file store is passphrase-free: the remote auto-provisions its own machine-
 * local key, so reads are headless. AGENTS_SECRETS_PASSPHRASE must NOT be
 * forwarded (PHNX-2371): a remote keyed to a secret its daemon does not hold
 * reports "Imported N key(s)" then fails every later decrypt.
 */
export function buildRemoteFileImportCommand(
  bundle: string,
  dotenv: string,
  opts: { force?: boolean; policyNever?: boolean } = {},
): { remoteCmd: string; input: string } {
  const force = opts.force ? ' --force' : '';
  const policy = opts.policyNever ? ' --policy never --i-understand' : '';
  const importCmd = `agents secrets import ${shellQuote(bundle)} --from - --backend file${force}${policy}`;
  // No prologue — AGENTS_SECRETS_PASSPHRASE stays unset on the remote.
  return { remoteCmd: `bash -lc ${shellQuote(importCmd)}`, input: dotenv };
}
