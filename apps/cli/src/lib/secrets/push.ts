/**
 * Push one bundle's values to a remote host over SSH — the provisioning
 * primitive behind `agents secrets export --host` and, from RUSH-1968, behind
 * `agents fleet apply --provision-secrets`.
 *
 * This logic used to live inline in the `export --host` command action. It moved
 * here because `lib/fleet/apply.ts` needs it and a lib MUST NOT import a command
 * module — and because the absence of a callable primitive is part of why
 * `fleet apply` never provisioned secrets at all, leaving an operator to
 * hand-export the file store's master key across the fleet.
 *
 * Two rules shape the shape of this module:
 *
 * - **It never prints.** The lib layer stays `console.*`-free (SEC-14/SEC-16), so
 *   every outcome is returned as data and the CALLER renders it. That is also
 *   what lets `fleet apply` fold a push into its own per-device report instead of
 *   interleaving stray lines into it.
 * - **Resolve once, push N times.** `resolveBundleForPush` is separate because
 *   reading a bundle can prompt (Touch ID); doing it per host would prompt per
 *   host. `export --host a,b,c` resolves once and pushes three times.
 */
import { sshExec, type SshExecResult } from '../ssh-exec.js';
import { remoteShellFor, buildWindowsStdinImportCommand } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import {
  remoteSecretsRaw,
  verifyRemoteKeychainPush,
  keychainWriteFailureMessage,
  buildRemoteFileImportCommand,
} from './remote.js';
import { readAndResolveBundleEnv } from './bundles.js';

/**
 * Serialize a resolved env map to `.env` lines that round-trip losslessly through
 * `parseDotenv` on the remote: `KEY="VALUE"`. parseDotenv strips exactly one outer
 * quote pair and takes the inner bytes verbatim (no unescaping), so any single-line
 * value survives unchanged with no escaping. Newlines would break its line-based
 * parse, so multi-line values are rejected rather than silently corrupted.
 */
export function bundleEnvToDotenv(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (/[\r\n]/.test(v)) {
      throw new Error(
        `Key '${k}' has a multi-line value; the SSH .env transport can't carry newlines. ` +
        `Set it directly on the remote with 'agents secrets add ${k} --value-stdin'.`,
      );
    }
    lines.push(`${k}="${v}"`);
  }
  return lines.join('\n') + '\n';
}

/** Where the bundle should live ON THE REMOTE. */
export type RemoteBackend = 'keychain' | 'file';

/** A bundle read once, ready to push to any number of hosts. */
export interface ResolvedBundleForPush {
  /** key -> value. Never logged; only its KEY NAMES are ever surfaced. */
  env: Record<string, string>;
  /** The same values as a dotenv blob, shipped over ssh stdin (never argv). */
  dotenv: string;
  keyCount: number;
}

export interface PushBundleOptions {
  remoteBackend: RemoteBackend;
  /** Overwrite a key that already exists on the remote. */
  force?: boolean;
  /**
   * Forwarded to the remote as the FIRST stdin line for the FILE backend only,
   * and only when non-empty.
   *
   * Empty is the DEFAULT and the good path: the remote's file store then
   * auto-provisions its own machine-local key (0600, `~/.agents/.secrets-key/`)
   * and reads headlessly. Setting this keys the remote bundle under a shared
   * off-disk secret instead — an opt-in, never a requirement. Requiring one is
   * what pushed operators toward exporting the master key fleet-wide (RUSH-1968).
   */
  passphrase?: string;
  /** Label for the audit trail — `export --host` vs `fleet apply`. */
  operation: string;
}

export interface PushBundleResult {
  ok: boolean;
  host: string;
  bundle: string;
  keyCount: number;
  /** One line for the caller to render. Never contains a secret value. */
  message: string;
}

/**
 * Read and resolve a bundle once, for pushing to one or more hosts.
 *
 * `agentOnly` + `keyMode: 'storage'` match what `export --host` has always
 * passed: storage-shaped values, and the headless guard that fails fast rather
 * than popping Touch ID inside an automated run.
 */
export function resolveBundleForPush(bundle: string, caller: string): ResolvedBundleForPush {
  const { env } = readAndResolveBundleEnv(bundle, { caller, keyMode: 'storage', agentOnly: true });
  return { env, dotenv: bundleEnvToDotenv(env), keyCount: Object.keys(env).length };
}

/**
 * Does this host need PowerShell rather than a POSIX `bash -lc`? Resolved from
 * the device registry / hosts overlay, never probed. Exported so the transport
 * choice is assertable on its own: the same predicate decides BOTH the Windows
 * file-backend refusal and the Windows keychain bridge below.
 */
export function isPowershellTarget(host: string): boolean {
  return remoteShellFor(resolveRemoteOsSync(host.split('@').pop() ?? host)) === 'powershell';
}

/**
 * Push an already-resolved bundle to ONE host.
 *
 * Drives the remote's own `agents secrets import --from -`, so the values land
 * in the remote's chosen backend and the .env is read off ssh stdin rather than
 * parsed by a remote shell. `import` auto-creates the bundle.
 */
export function pushResolvedBundleToHost(
  resolved: ResolvedBundleForPush,
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): PushBundleResult {
  const fail = (message: string): PushBundleResult =>
    ({ ok: false, host, bundle, keyCount: resolved.keyCount, message });

  let res: SshExecResult;
  if (opts.remoteBackend === 'file') {
    // Both file-backend paths build a POSIX `bash -lc` command. Refuse a Windows
    // target cleanly rather than emit broken PowerShell (fail loud at the
    // boundary, never a silent wrong path).
    if (isPowershellTarget(host)) {
      return fail('file backend export to a Windows target is not yet supported');
    }
    const { remoteCmd, input } = buildRemoteFileImportCommand(bundle, resolved.dotenv, {
      passphrase: opts.passphrase ?? '',
      force: opts.force,
    });
    res = sshExec(host, remoteCmd, { input });
  } else if (isPowershellTarget(host)) {
    // Keychain on a Windows target: the `agents.ps1` shim doesn't forward
    // ssh-piped stdin to node, so `--from -` would hang. Bridge the piped .env
    // through PowerShell into a temp file and import `--from <file>` (deleted
    // afterwards). Same hardened ssh engine; the .env still only ever crosses
    // the wire over ssh stdin.
    res = sshExec(host, buildWindowsStdinImportCommand(bundle, { force: opts.force }), { input: resolved.dotenv });
  } else {
    // Keychain on a POSIX target: OS-aware wrapping + the hardened ssh engine
    // (BatchMode, ConnectTimeout, keepalive, control-socket reuse) via the same
    // path the READ inverse (`remoteResolveEnv`) uses.
    res = remoteSecretsRaw(
      host,
      ['import', bundle, '--from', '-', ...(opts.force ? ['--force'] : [])],
      { input: resolved.dotenv, osLookupName: host },
    );
  }

  if (res.code === null) {
    return fail(res.stderr.trim() || (res.timedOut ? 'ssh timed out' : 'ssh failed'));
  }
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || '').trim();
    return fail(`remote import failed (exit ${res.code})${msg ? `: ${msg}` : ''}`);
  }

  // A keychain-backed push to a macOS remote over headless SSH can land the
  // bundle metadata but no READABLE value items: the remote login keychain is
  // locked in the non-interactive SSH context, so Security accepts the write but
  // the biometry-ACL'd item is unreadable — and the remote `import` still exits
  // 0. Read it back the way a release will and FAIL LOUDLY, rather than leave a
  // metadata-only bundle that breaks later with "stored item not found". The
  // file backend is headless-readable by construction, so it is skipped.
  if (opts.remoteBackend === 'keychain') {
    const verdict = verifyRemoteKeychainPush(host, bundle, Object.keys(resolved.env), { osLookupName: host });
    if (!verdict.ok) {
      return fail(verdict.kind === 'locked-keychain'
        ? keychainWriteFailureMessage(host, bundle, verdict.reason)
        : `pushed '${bundle}' but could not verify it on the remote: ${verdict.reason}`);
    }
  }

  const remoteMsg = (res.stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return {
    ok: true,
    host,
    bundle,
    keyCount: resolved.keyCount,
    message: remoteMsg || `${resolved.keyCount} key(s) exported`,
  };
}

/** Resolve and push in one call — for a single host. */
export function pushBundleToHost(
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): PushBundleResult {
  return pushResolvedBundleToHost(resolveBundleForPush(bundle, opts.operation), bundle, host, opts);
}
