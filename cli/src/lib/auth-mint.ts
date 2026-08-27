/**
 * First-class setup-token mint + seed (PHNX-2364).
 *
 * Closes the mint-auth manual recipe: drive `claude setup-token` through the
 * same injectable PTY driver `agents fleet login` uses, capture a well-formed
 * `sk-ant-oat01-…` token (the #1767 ANSI-banner guard), and seed BOTH:
 *
 *   1. a named provider account (`agents accounts add` shape, policy never)
 *   2. the reserved FILE-BASED `auth` bundle keyed per-account email, which
 *      usage/probe reads (`resolveClaudeSetupToken`)
 *
 * Native rotating OAuth is never copied. Only this non-rotating class is
 * stored and optionally synced. Interactive mint is Claude-only; every other
 * harness fails loud with the command that actually provisions it.
 */
import type { AgentId } from './types.js';
import { resolveAgentName } from './agents.js';
import {
  AUTH_BUNDLE,
  claudeAccountTokenKey,
  isValidClaudeSetupToken,
  readClaudeAccountEmail,
} from './claude-account-token.js';
import { addAccount, findAccount, readAccountRegistry, setAccountSecret, type CredentialAccount } from './account-registry.js';
import {
  bundleBackend,
  bundleExists,
  keychainRef,
  readBundle,
  rotateBundleSecret,
  writeBundleWithItems,
  type SecretsBundle,
} from './secrets/bundles.js';
import { secretsKeychainItem } from './secrets/index.js';
import { getBinaryPath, getGlobalDefault, getVersionHomePath, listInstalledVersions } from './installations/versions.js';
import { shellQuote } from './ssh-exec.js';
import {
  defaultPtyDriver,
  type DriveOptions,
  type PtyDriver,
} from './fleet/remote-login.js';
import { showUrl } from './open-url.js';
import { loadDevices } from './devices/registry.js';
import { isSelfHost } from './devices/self-host.js';
import { pushBundleToHost } from './secrets/push.js';
import { assertCredentialTransportHostPinned, resolveHostSshTarget } from './secrets/remote.js';
import { resolveRemoteOsSync } from './hosts/remote-os.js';

/** Well-formed Claude setup-token as it appears inside a TTY blob. */
export const CLAUDE_SETUP_TOKEN_CAPTURE_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;

const ACCOUNT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MintFlow {
  harness: AgentId;
  provider: string;
  auth: 'setup-token';
  /** Interactive mint argv after HOME=… <bin>. Null when stdin-seed only. */
  mintArgs: string[] | null;
  verificationUrlRegex: RegExp;
  tokenCapture: RegExp;
}

/**
 * Harnesses that expose an interactive setup-token mint. Native device-code
 * login (codex/droid/kimi/grok) stays on `agents fleet login`; API keys stay
 * on `agents accounts add`. Adding a harness here without a real mint command
 * is a lying table — do not.
 */
export const MINT_FLOWS: Record<string, MintFlow> = {
  claude: {
    harness: 'claude',
    provider: 'anthropic',
    auth: 'setup-token',
    mintArgs: ['setup-token'],
    // Authorize URL printed by `claude setup-token` before it waits for a code.
    verificationUrlRegex: /(https:\/\/[^\s"'<>]+)/i,
    tokenCapture: CLAUDE_SETUP_TOKEN_CAPTURE_RE,
  },
};

export function listMintableHarnesses(): AgentId[] {
  return Object.keys(MINT_FLOWS) as AgentId[];
}

export function getMintFlow(harnessRaw: string): MintFlow {
  const harness = resolveAgentName(harnessRaw);
  if (!harness) {
    throw new Error(
      `Unknown harness '${harnessRaw}'. Interactive setup-token mint is implemented for: ${listMintableHarnesses().join(', ')}.`,
    );
  }
  const flow = MINT_FLOWS[harness];
  if (flow) return flow;
  throw new Error(unmintableMessage(harness));
}

export function unmintableMessage(harness: string): string {
  return [
    `Cannot mint a setup-token for '${harness}'.`,
    `Interactive setup-token mint is implemented for: ${listMintableHarnesses().join(', ')}.`,
    `Device-code native login is \`agents fleet login --agent ${harness}\`.`,
    `API-key / pasted-token accounts use \`agents accounts add <name> --provider <provider> --auth api-key\`.`,
  ].join(' ');
}

/** Strip CSI / Fe ANSI so a #1767 TTY blob can be scanned for a real token. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Pull a single well-formed Claude setup-token out of a (possibly ANSI-wrapped)
 * screen. Returns null when none is present. Two distinct tokens fail loud —
 * guessing which one to seed is how a banner fragment becomes an auth header.
 */
export function extractClaudeSetupToken(screen: string): string | null {
  const text = stripAnsi(screen);
  const matches = text.match(new RegExp(CLAUDE_SETUP_TOKEN_CAPTURE_RE.source, 'g')) ?? [];
  const unique = [...new Set(matches.filter(isValidClaudeSetupToken))];
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    throw new Error(
      `Screen contained ${unique.length} distinct setup-tokens; refusing to guess. Re-run mint and capture a single sk-ant-oat01- token.`,
    );
  }
  return unique[0]!;
}

/** First https URL on the screen, trailing punctuation stripped. */
export function extractMintUrl(screen: string, flow: MintFlow): string | undefined {
  const text = stripAnsi(screen);
  const m = text.match(flow.verificationUrlRegex);
  if (!m) return undefined;
  const raw = (m[1] ?? m[0]).trim();
  return raw.replace(/[.,;:]+$/, '') || undefined;
}

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** Account-name slug of an email (`ada@example.com` → `ada-at-example.com`). */
export function accountNameFromEmail(email: string): string {
  const slug = email
    .trim()
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/[^a-z0-9._-]/g, '-');
  if (!ACCOUNT_NAME_RE.test(slug)) {
    throw new Error(`Cannot derive an account name from email '${email}'. Pass --account <name>.`);
  }
  return slug;
}

export function assertValidSetupToken(token: string): string {
  const cleaned = token.trim();
  if (!isValidClaudeSetupToken(cleaned)) {
    throw new Error(
      'Not a Claude setup-token (expected a single-line sk-ant-oat01-… value). The #1767 capture stored the TTY banner as the token — that is not a token. Re-run `claude setup-token` and paste only the sk-ant-oat01- line.',
    );
  }
  return cleaned;
}

export interface ResolveMintIdentityInput {
  account?: string;
  email?: string;
  home?: string;
}

export interface ResolvedMintIdentity {
  accountName: string;
  email: string;
}

/**
 * Resolve the named account + the email that keys the reserved `auth` bundle.
 * `--account` that looks like an email is the email; a name needs `--email` or
 * a locally signed-in `.claude.json`. Missing email fails loud — we must not
 * fall back to a bare shared key (that is the multi-account mix-up).
 */
export function resolveMintIdentity(input: ResolveMintIdentityInput): ResolvedMintIdentity {
  const accountRaw = input.account?.trim();
  const emailRaw = input.email?.trim();
  const fromHome = readClaudeAccountEmail(input.home);

  let email: string | undefined;
  let accountName: string | undefined;

  if (emailRaw) {
    if (!isEmail(emailRaw)) throw new Error(`--email '${emailRaw}' is not an email address.`);
    email = emailRaw;
  }
  if (accountRaw) {
    if (isEmail(accountRaw)) {
      if (email && email.toLowerCase() !== accountRaw.toLowerCase()) {
        throw new Error(`--account '${accountRaw}' and --email '${email}' name different emails.`);
      }
      email = accountRaw;
      accountName = accountNameFromEmail(accountRaw);
    } else {
      if (!ACCOUNT_NAME_RE.test(accountRaw)) {
        throw new Error(
          `Account name '${accountRaw}' must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.`,
        );
      }
      accountName = accountRaw;
    }
  }
  if (!email) email = fromHome ?? undefined;
  if (!email) {
    throw new Error(
      "Cannot key a per-account setup-token without an email. Pass --account <email>, or --email, or sign in locally first so this version home's .claude.json has oauthAccount.emailAddress.",
    );
  }
  if (!accountName) accountName = accountNameFromEmail(email);
  return { accountName, email };
}

/**
 * Write (or rotate) the reserved FILE-BASED `auth` bundle's per-account key.
 * Usage/probe ignores a keychain- or vault-backed bundle of this name, so a
 * wrong backend fails loud instead of looking like a successful mint.
 */
export function seedReservedAuthToken(email: string, token: string): { key: string } {
  const cleaned = assertValidSetupToken(token);
  const key = claudeAccountTokenKey(email);
  if (bundleExists(AUTH_BUNDLE)) {
    const backend = bundleBackend(AUTH_BUNDLE);
    if (backend !== 'file') {
      throw new Error(
        `Reserved bundle '${AUTH_BUNDLE}' exists with backend '${backend}', but usage/probe only reads a FILE-backed auth bundle. Recreate it with: agents secrets create ${AUTH_BUNDLE} --backend file --policy never --i-understand --force`,
      );
    }
    const bundle = readBundle(AUTH_BUNDLE);
    if (key in bundle.vars) {
      rotateBundleSecret(bundle, key, { newValue: cleaned, meta: { type: 'token' } });
      return { key };
    }
    const item = secretsKeychainItem(AUTH_BUNDLE, key);
    bundle.vars[key] = keychainRef(key);
    if (!bundle.meta) bundle.meta = {};
    bundle.meta[key] = { type: 'token' };
    writeBundleWithItems(bundle, new Map([[item, cleaned]]));
    return { key };
  }
  const item = secretsKeychainItem(AUTH_BUNDLE, key);
  const bundle: SecretsBundle = {
    name: AUTH_BUNDLE,
    backend: 'file',
    policy: 'never',
    description: 'Reserved per-account Claude setup-tokens for unattended usage/probe (never copy native OAuth).',
    vars: { [key]: keychainRef(key) },
    meta: { [key]: { type: 'token' } },
  };
  writeBundleWithItems(bundle, new Map([[item, cleaned]]));
  return { key };
}

/**
 * Create or rotate the named provider account that `agents run --account` and
 * `agents accounts sync` consume. Existing account of a different kind fails
 * loud rather than silently overwriting an API key with a setup-token.
 */
export function seedNamedAccount(name: string, token: string, flow: MintFlow): CredentialAccount {
  const cleaned = assertValidSetupToken(token);
  const existing = findAccount(name);
  if (!existing) return addAccount(name, flow.provider, flow.auth, cleaned);
  if (existing.provider !== flow.provider || existing.auth !== flow.auth) {
    throw new Error(
      `Account '${name}' already exists as ${existing.provider} ${existing.auth}; not overwriting it with a ${flow.provider} ${flow.auth}. Choose a different --account name.`,
    );
  }
  setAccountSecret(name, cleaned);
  return existing;
}

export interface MintDriveHooks {
  driver?: PtyDriver;
  openUrl?: (url: string) => Promise<void>;
  /** Asked once the authorize URL is on screen, when `--code` was not given. */
  readCode?: () => Promise<string | undefined>;
  drive?: DriveOptions;
}

export interface DriveMintResult {
  token: string;
  url?: string;
  sessionId: string;
}

/**
 * Drive `claude setup-token` in a PTY: scrape the authorize URL, open it,
 * optionally paste `--code`, then capture the token with the #1767 guard.
 * Tears the session down on the way out (success, timeout, or throw).
 */
export async function driveSetupTokenMint(
  command: string,
  flow: MintFlow,
  opts: MintDriveHooks & { code?: string } = {},
): Promise<DriveMintResult> {
  const driver = opts.driver ?? defaultPtyDriver();
  const initialDelayMs = opts.drive?.initialDelayMs ?? 1500;
  const pollMs = opts.drive?.pollMs ?? 500;
  const timeoutMs = opts.drive?.timeoutMs ?? 180_000;
  const openUrl = opts.openUrl ?? (async (url: string) => {
    const shown = await showUrl(url);
    if (shown.via === 'none') {
      console.error(`Could not open a browser — open this yourself:\n  ${url}`);
    }
  });

  const id = await driver.start();
  let opened: string | undefined;
  let wroteCode = false;
  let askedCode = false;
  try {
    await driver.exec(id, command);
    await sleep(initialDelayMs);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { screen, exited } = await driver.screen(id);
      const url = extractMintUrl(screen, flow);
      const token = extractClaudeSetupToken(screen);
      if (token) return { token, url: url ?? opened, sessionId: id };
      if (url && url !== opened) {
        opened = url;
        await openUrl(url);
      }
      if (url && !wroteCode && !askedCode) {
        const code = opts.code ?? await opts.readCode?.();
        askedCode = true;
        if (code?.trim()) {
          await driver.write(id, `${code.trim()}\r`);
          wroteCode = true;
        }
      }
      if (exited) {
        throw new Error(
          opened
            ? `Mint process exited before printing a setup-token. Authorize URL was ${opened}. Re-run and complete the browser step, or seed with --token-stdin.`
            : 'Mint process exited before printing an authorize URL or a setup-token.',
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          opened
            ? `Timed out waiting for a setup-token after opening ${opened}. Paste the code with --code, or seed an already-minted token with --token-stdin.`
            : 'Timed out waiting for `claude setup-token` to print an authorize URL.',
        );
      }
      await sleep(pollMs);
    }
  } catch (e) {
    await driver.stop(id).catch(() => {});
    throw e;
  } finally {
    await driver.stop(id).catch(() => {});
  }
}

export function buildMintCommand(flow: MintFlow, bin: string, home: string): string {
  if (!flow.mintArgs) {
    throw new Error(`Harness '${flow.harness}' has no interactive mint command.`);
  }
  const args = flow.mintArgs.map(shellQuote).join(' ');
  return `HOME=${shellQuote(home)} ${shellQuote(bin)} ${args}`;
}

export function resolveMintInstallation(harness: AgentId): { version: string; bin: string; home: string } {
  const installed = listInstalledVersions(harness);
  const version = getGlobalDefault(harness) ?? installed[installed.length - 1];
  if (!version) {
    throw new Error(`No installed version of ${harness}. Install one with: agents add ${harness}`);
  }
  return {
    version,
    bin: getBinaryPath(harness, version),
    home: getVersionHomePath(harness, version),
  };
}

export interface MintAndSeedInput {
  harness: string;
  account?: string;
  email?: string;
  token?: string;
  code?: string;
  open?: boolean;
  fleet?: boolean;
  devices?: string[];
  hooks?: MintDriveHooks;
}

export interface FleetSyncRow {
  device: string;
  ok: boolean;
  message: string;
}

export interface MintAndSeedResult {
  harness: AgentId;
  account: string;
  email: string;
  authBundleKey: string;
  rotated: boolean;
  fleet: FleetSyncRow[];
}

/**
 * End-to-end mint: resolve identity, obtain a token (stdin or PTY drive),
 * seed the named account + reserved auth bundle, optionally sync the fleet.
 * Never returns or logs the token.
 */
export async function mintAndSeed(input: MintAndSeedInput): Promise<MintAndSeedResult> {
  const flow = getMintFlow(input.harness);
  const install = input.token ? null : resolveMintInstallation(flow.harness);
  const identity = resolveMintIdentity({
    account: input.account,
    email: input.email,
    home: install?.home,
  });

  let token: string;
  if (input.token !== undefined) {
    token = assertValidSetupToken(input.token);
  } else {
    const command = buildMintCommand(flow, install!.bin, install!.home);
    const openUrl = input.open === false
      ? async (url: string) => {
        console.log(`Authorize: ${url}`);
      }
      : input.hooks?.openUrl;
    const driven = await driveSetupTokenMint(command, flow, {
      driver: input.hooks?.driver,
      openUrl,
      readCode: input.hooks?.readCode,
      drive: input.hooks?.drive,
      code: input.code,
    });
    token = driven.token;
    if (driven.url) console.log(`Authorize URL: ${driven.url}`);
  }

  const existing = findAccount(identity.accountName);
  const account = seedNamedAccount(identity.accountName, token, flow);
  const { key } = seedReservedAuthToken(identity.email, token);

  const targets = await resolveSyncTargets(input.fleet === true, input.devices ?? []);
  const fleet: FleetSyncRow[] = [];
  for (const device of targets) {
    fleet.push(await syncMintedBundles(account.name, device));
  }
  const failed = fleet.filter((row) => !row.ok);
  if (failed.length) {
    throw new Error(
      `Minted locally but fleet sync failed for: ${failed.map((row) => `${row.device} (${row.message})`).join('; ')}. Retry: agents accounts sync ${account.name} <device>`,
    );
  }

  return {
    harness: flow.harness,
    account: account.name,
    email: identity.email,
    authBundleKey: key,
    rotated: Boolean(existing),
    fleet,
  };
}

export async function resolveSyncTargets(fleet: boolean, devices: string[]): Promise<string[]> {
  const named = [...new Set(devices.map((d) => d.trim()).filter(Boolean))];
  if (!fleet && named.length === 0) return [];
  const registry = await loadDevices();
  const known = Object.keys(registry);
  if (named.length) {
    // A self host in --device is skipped, not an error; an unknown name is.
    const unknown = named.filter((d) => !known.includes(d) && !isSelfHost(d));
    if (unknown.length) {
      throw new Error(
        `Unknown device${unknown.length === 1 ? '' : 's'} '${unknown.join("', '")}'. Register with \`agents devices\` or omit --device.`,
      );
    }
  }
  const fromFleet = fleet
    ? known.filter((name) => !isSelfHost(name))
    : [];
  const union = [...new Set([...fromFleet, ...named.filter((d) => !isSelfHost(d))])];
  return union;
}

async function syncMintedBundles(accountName: string, device: string): Promise<FleetSyncRow> {
  try {
    const sshTarget = await resolveHostSshTarget(device);
    assertCredentialTransportHostPinned(sshTarget);
    const remoteBackend = resolveRemoteOsSync(device) === 'win32' ? 'keychain' : 'file';
    const account = findAccount(accountName);
    if (!account) throw new Error(`Unknown provider account '${accountName}'.`);
    const accountPush = pushBundleToHost(accountName, device, {
      remoteBackend,
      force: true,
      operation: 'accounts mint --fleet',
      policyNever: true,
      agentOnly: false,
      literalValues: {
        ACCOUNT_ID: account.id,
        PROVIDER: account.provider,
        AUTH_TYPE: account.auth,
        ...(account.baseUrl ? { BASE_URL: account.baseUrl } : {}),
      },
    });
    if (!accountPush.ok) throw new Error(accountPush.message);
    if (bundleExists(AUTH_BUNDLE)) {
      const authPush = pushBundleToHost(AUTH_BUNDLE, device, {
        remoteBackend: 'file',
        force: true,
        operation: 'accounts mint --fleet',
        policyNever: true,
        agentOnly: true,
      });
      if (!authPush.ok) throw new Error(authPush.message);
    }
    return { device, ok: true, message: `${accountPush.keyCount} keys` };
  } catch (err) {
    return { device, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** True when a Claude setup-token is already seeded on this box (setup status). */
export function hasMintedSetupToken(): { ready: boolean; detail: string } {
  const records = Object.values(readAccountRegistry().accounts);
  const setup = records.filter((a) => a.auth === 'setup-token' && a.provider === 'anthropic');
  if (setup.length) {
    return { ready: true, detail: `${setup.length} Claude setup-token account${setup.length === 1 ? '' : 's'}` };
  }
  if (bundleExists(AUTH_BUNDLE) && bundleBackend(AUTH_BUNDLE) === 'file') {
    const bundle = readBundle(AUTH_BUNDLE);
    const keys = Object.keys(bundle.vars).filter((k) => k.startsWith('CLAUDE_CODE_OAUTH_TOKEN_'));
    if (keys.length) return { ready: true, detail: `reserved auth bundle (${keys.length} account key${keys.length === 1 ? '' : 's'})` };
  }
  return { ready: false, detail: 'no Claude setup-token minted — agents accounts mint claude' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
