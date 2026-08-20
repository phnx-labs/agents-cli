import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import {
  clearPrixSession,
  fetchWhoAmI,
  pollDeviceToken,
  PrixApiError,
  readPrixSession,
  resolvePrixToken,
  startDeviceAuthorization,
  writePrixSession,
} from '../lib/prix-account.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * `agents auth login` — RFC 8628 device-code flow against the already-shipped
 * `/api/v1/auth/device/*` routes. If the live API rejects the request shape
 * (a route this spec missed, or the endpoint moved), this fails loud with the
 * `rush login` fallback rather than silently stubbing a fake session.
 */
export async function runAuthLogin(): Promise<void> {
  let authorization;
  try {
    authorization = await startDeviceAuthorization();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const existing = resolvePrixToken();
    if (existing?.source === 'rush') {
      console.log(chalk.yellow(`Device login is unavailable right now (${message}), but you're already signed in via 'rush login'.`));
      console.log("Run 'agents auth whoami' to confirm.");
      return;
    }
    throw new Error(`Device login is unavailable right now (${message}). Run 'rush login' instead, then 'agents auth whoami' to confirm.`);
  }

  console.log(`To sign in, open:\n\n  ${chalk.cyan(authorization.verification_uri_complete)}\n`);
  console.log(chalk.gray(`(code: ${authorization.user_code})`));

  const deadline = Date.now() + authorization.expires_in * 1000;
  let interval = Math.max(authorization.interval, 1) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await pollDeviceToken(authorization.device_code);
    if (poll.status === 'pending') continue;
    if (poll.status === 'slow_down') { interval += 1000; continue; }
    if (poll.status === 'expired') throw new Error('Login code expired. Run `agents auth login` again.');
    if (poll.status === 'denied') throw new Error('Login was denied.');
    writePrixSession({
      access_token: poll.access_token,
      refresh_token: poll.refresh_token,
      expires_at: poll.expires_in ? Date.now() + poll.expires_in * 1000 : undefined,
      email: poll.user.email,
      userId: poll.user.id,
    });
    console.log(chalk.green(`Signed in as ${poll.user.email}.`));
    return;
  }
  throw new Error('Login code expired. Run `agents auth login` again.');
}

async function runAuthWhoami(json: boolean): Promise<void> {
  const resolved = resolvePrixToken();
  if (!resolved) throw new Error("Not signed in. Run 'agents auth login' first.");
  let who;
  try {
    who = await fetchWhoAmI(resolved.token);
  } catch (err) {
    if (err instanceof PrixApiError && err.status === 401) {
      throw new Error(`Signed-in token is no longer valid (${resolved.source === 'agents' ? "run 'agents auth login'" : "run 'rush login'"} again).`);
    }
    throw err;
  }
  if (json) {
    console.log(JSON.stringify({ ...who, source: resolved.source }, null, 2));
    return;
  }
  console.log(`${chalk.bold(who.email)}  ${chalk.gray(who.userId)}`);
  console.log(chalk.gray(`signed in via ${resolved.source === 'agents' ? "'agents auth login'" : "'rush login' (shared session)"}`));
}

function runAuthLogout(): void {
  const cleared = clearPrixSession();
  const rushRemains = resolvePrixToken()?.source === 'rush';
  if (!cleared && !readPrixSession()) {
    console.log(chalk.gray('Not signed in via `agents auth login` — nothing to clear.'));
  } else {
    console.log(chalk.green('Signed out.'));
  }
  if (rushRemains) {
    console.log(chalk.gray("You're still signed in via `rush login` — `agents auth whoami` will use that session. Run `rush logout` to clear it too."));
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Sign in to your Rush account (shared by `agents org` and paid tiers)');

  auth.command('login').description('Sign in via the device-code flow').action(async () => runAuthLogin());

  auth.command('whoami').description('Show the signed-in account').option('--json', 'Machine-readable output')
    .action((o: { json?: boolean }, command: Command) => runAuthWhoami(!!(o.json || command.optsWithGlobals().json)));

  auth.command('logout').description('Clear the local `agents auth login` session').action(() => runAuthLogout());

  setHelpSections(auth, {
    examples: `agents auth login
agents auth whoami
agents auth whoami --json
agents auth logout`,
    notes: "`agents auth login` writes its own session, separate from \`rush login\`'s \`~/.rush/user.yaml\` — \`agents auth logout\` never signs you out of \`rush\`. If you're already signed in via \`rush login\`, \`agents auth whoami\`/\`agents org\` use that session automatically; no separate login is required.",
  });
}
