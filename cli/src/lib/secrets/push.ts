/**
 * Push one bundle's values to a remote host over SSH — the provisioning
 * primitive behind `agents secrets export --device` and, from RUSH-1968, behind
 * `agents fleet apply --provision-secrets`.
 *
 * This logic used to live inline in the `export --device` command action. It moved
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
 *   host. `export --device a,b,c` resolves once and pushes three times.
 */
import { sshExec, type SshExecResult } from '../ssh-exec.js';
import { remoteShellFor, buildWindowsStdinImportCommand } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import {
  remoteSecretsRaw,
  verifyRemoteKeychainPush,
  keychainWriteFailureMessage,
  buildRemoteFileImportCommand,
  credentialTransportSshOpts,
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
  /** Label for the audit trail — `export --device` vs `fleet apply`. */
  operation: string;
  /** Preserve an automation account's permanent prompt-free policy remotely. */
  policyNever?: boolean;
  /** Permit a human-invoked push to read locally without requiring the agent broker. */
  agentOnly?: boolean;
  /** Non-secret literals whose bundle value kind must survive the dotenv transport. */
  literalValues?: Record<string, string>;
}

export interface PushBundleResult {
  ok: boolean;
  host: string;
  bundle: string;
  keyCount: number;
  /** One line for the caller to render. Never contains a secret value. */
  message: string;
}

export interface LiteralRestorePlan {
  key: string;
  removeArgs: string[];
  addArgs: string[];
}

/** Preserve the literal-vs-secret schema that dotenv transport cannot encode. */
export function planLiteralRestoration(bundle: string, literalValues: Record<string, string> = {}): LiteralRestorePlan[] {
  return Object.entries(literalValues).map(([key, value]) => ({
    key,
    removeArgs: ['remove', bundle, key, '--yes'],
    addArgs: ['add', bundle, key, '--value', value],
  }));
}

/**
 * Read and resolve a bundle once, for pushing to one or more hosts.
 *
 * `keyMode: 'storage'` is fixed — a push always sends storage-shaped values.
 *
 * `agentOnly` is the caller's to decide, and it is NOT a security level: it
 * selects the broker-only read (fail fast with the `agents secrets unlock` hint)
 * over the interactive read (macOS may raise a Touch ID sheet). The headless
 * guard exists because an AGENT LAUNCH must never enumerate the keychain — a
 * per-bundle prefix becomes a broad `agents-cli.` scan after service-name
 * hashing, and macOS evaluates unrelated biometry ACLs during it, one sheet per
 * installed version (bundles.ts, RUSH-2440). A human at a TTY is not that case:
 * they can answer one prompt, and the interactive sibling reads (`view --reveal`,
 * `exec`) already let them. NOT `get` — it is unconditionally `agentOnly` on
 * purpose, because prompting would hang a `$(agents secrets get …)` capture
 * mid-pipeline (SEC-13b). It defaults to `true` so an automated caller that says
 * nothing stays broker-only.
 */
export function resolveBundleForPush(
  bundle: string,
  caller: string,
  opts: { agentOnly?: boolean } = {},
): ResolvedBundleForPush {
  const agentOnly = opts.agentOnly ?? true;
  const { env } = readAndResolveBundleEnv(bundle, { caller, keyMode: 'storage', agentOnly });
  return { env, dotenv: bundleEnvToDotenv(env), keyCount: Object.keys(env).length };
}

function isPowershellTarget(host: string): boolean {
  return remoteShellFor(resolveRemoteOsSync(host.split('@').pop() ?? host)) === 'powershell';
}

/**
 * WHICH transport a (backend, target-OS) pair selects, and the exact bytes it
 * will send. One of four outcomes, and picking the wrong one is silent: a
 * Windows target handed a POSIX `bash -lc` produces garbage, and a Windows
 * target handed `--from -` hangs forever on a stdin the `agents.ps1` shim never
 * forwards. Neither shows up as a failed ssh, so the selection is the thing
 * worth pinning.
 *
 * Separated from execution so it is decidable without a network: the branch is
 * chosen from the device registry alone, and `pushResolvedBundleToHost` below
 * does nothing but run what this returns.
 */
export type PushTransport =
  /** No supported command exists for this pair — fail loud, never a wrong path. */
  | { kind: 'refuse'; message: string }
  /**
   * A command sent over the raw ssh engine, with the .env on stdin. `multiplex`
   * is always `false`: a push ships credential bytes, so its connection must not
   * reuse — or leave behind — a persistent authenticated control master to the
   * destination the way the default fan-out connections do (RUSH-2527). This
   * mirrors the `--copy-creds` dispatch posture (`multiplex: !opts.copyCreds`).
   */
  | { kind: 'ssh'; remoteCmd: string; input: string; multiplex: false }
  /** The OS-aware `agents secrets` wrapper, the READ inverse's own path. Never multiplexed — see the `ssh` kind. */
  | { kind: 'remote-secrets'; args: string[]; input: string; multiplex: false };

/** Choose the transport for one push. Pure: registry read in, plan out. */
export function planPushTransport(
  resolved: ResolvedBundleForPush,
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): PushTransport {
  const powershell = isPowershellTarget(host);
  if (opts.remoteBackend === 'file') {
    // Both file-backend paths build a POSIX `bash -lc` command. Refuse a Windows
    // target cleanly rather than emit broken PowerShell (fail loud at the
    // boundary, never a silent wrong path).
    if (powershell) {
      return { kind: 'refuse', message: 'file backend export to a Windows target is not yet supported' };
    }
    const { remoteCmd, input } = buildRemoteFileImportCommand(bundle, resolved.dotenv, {
      passphrase: opts.passphrase ?? '',
      force: opts.force,
      policyNever: opts.policyNever,
    });
    return { kind: 'ssh', remoteCmd, input, multiplex: false };
  }
  if (powershell) {
    // Keychain on a Windows target: the `agents.ps1` shim doesn't forward
    // ssh-piped stdin to node, so `--from -` would hang. Bridge the piped .env
    // through PowerShell into a temp file and import `--from <file>` (deleted
    // afterwards). Same hardened ssh engine; the .env still only ever crosses
    // the wire over ssh stdin.
    return {
      kind: 'ssh',
      remoteCmd: buildWindowsStdinImportCommand(bundle, { force: opts.force, policyNever: opts.policyNever }),
      input: resolved.dotenv,
      multiplex: false,
    };
  }
  // Keychain on a POSIX target: OS-aware wrapping + the hardened ssh engine
  // (BatchMode, ConnectTimeout, keepalive, control-socket reuse) via the same
  // path the READ inverse (`remoteResolveEnv`) uses.
  return {
    kind: 'remote-secrets',
    args: [
      'import', bundle, '--from', '-',
      ...(opts.force ? ['--force'] : []),
      ...(opts.policyNever ? ['--policy', 'never', '--i-understand'] : []),
    ],
    input: resolved.dotenv,
    multiplex: false,
  };
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

  const plan = planPushTransport(resolved, bundle, host, opts);
  if (plan.kind === 'refuse') return fail(plan.message);
  // Every ssh below rides the credential-transport posture: the managed host key
  // is pinned (a changed key is refused) and the connection never reuses or
  // leaves a persistent authenticated control master to the destination
  // (RUSH-2527, `credentialTransportSshOpts`). The plan's `multiplex: false` is
  // the raw-`ssh` branch's half of that; the `remote-secrets` branch and the
  // read-back/policy/literal follow-ups pass `secret: true` for the same posture.
  const res: SshExecResult = plan.kind === 'ssh'
    ? sshExec(host, plan.remoteCmd, { input: plan.input, hostKeyOpts: credentialTransportSshOpts(host).hostKeyOpts, multiplex: plan.multiplex })
    : remoteSecretsRaw(host, plan.args, { input: plan.input, osLookupName: host, secret: true });

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
    const verdict = verifyRemoteKeychainPush(host, bundle, Object.keys(resolved.env), { osLookupName: host, secret: true });
    if (!verdict.ok) {
      return fail(verdict.kind === 'locked-keychain'
        ? keychainWriteFailureMessage(host, bundle, verdict.reason)
        : `pushed '${bundle}' but could not verify it on the remote: ${verdict.reason}`);
    }
  }

  for (const step of planLiteralRestoration(bundle, opts.literalValues)) {
    const removed = remoteSecretsRaw(host, step.removeArgs, { osLookupName: host, secret: true });
    if (removed.code !== 0) {
      const msg = (removed.stderr || removed.stdout || '').trim();
      return fail(`pushed '${bundle}' but could not replace transported ${step.key}${msg ? `: ${msg}` : ''}`);
    }
    const literal = remoteSecretsRaw(host, step.addArgs, { osLookupName: host, secret: true });
    if (literal.code !== 0) {
      const msg = (literal.stderr || literal.stdout || '').trim();
      return fail(`pushed '${bundle}' but could not preserve literal ${step.key}${msg ? `: ${msg}` : ''}`);
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
  return pushResolvedBundleToHost(resolveBundleForPush(bundle, opts.operation, { agentOnly: opts.agentOnly }), bundle, host, opts);
}
