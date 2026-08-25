/**
 * `agents open` — resolve an `agents://` deep link, and manage the OS handler
 * that routes such links here.
 *
 *   agents open agents://session/<id>     resume that session in a terminal
 *   agents open register                  register the agents:// scheme with the OS
 *   agents open unregister                remove the handler
 *   agents open status                    report whether the handler is registered
 *
 * A rendered artifact (plan/report) embeds `agents://session/<id>` in its
 * provenance line; clicking it hands the URL to the OS, which invokes
 * `agents open <url>`. This command parses it (lib/deeplink/url.ts) and hands the
 * session id to the existing resume dispatcher, which resolves the owning host
 * and opens the terminal with the cursor in the input bar. The id is passed as
 * argv, never interpolated into a shell.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { parseAgentsUrl } from '../lib/deeplink/url.js';
import {
  registerAgentsUrlScheme,
  unregisterAgentsUrlScheme,
  agentsUrlSchemeStatus,
} from '../lib/deeplink/register.js';

export function registerOpenCommand(program: Command): void {
  const open = program
    .command('open [url]')
    .description('Resume a session from an agents:// deep link, or register/unregister/status the OS URL-scheme handler.')
    .action(async (url: string | undefined) => {
      if (!url) {
        open.help();
        return;
      }
      await handleUrl(url);
    });

  open
    .command('register')
    .description('Register the agents:// URL scheme with the OS so artifact links resume sessions (idempotent).')
    .action(() => {
      const status = registerAgentsUrlScheme();
      if (status.registered) {
        console.log(chalk.green('agents:// scheme registered.') + chalk.gray(` ${status.detail}`));
      } else {
        console.log(chalk.yellow('Could not register the agents:// scheme.') + chalk.gray(` ${status.detail}`));
        process.exitCode = 1;
      }
    });

  open
    .command('unregister')
    .description('Remove the agents:// URL scheme handler.')
    .action(() => {
      const status = unregisterAgentsUrlScheme();
      console.log(chalk.gray(status.detail));
    });

  open
    .command('status')
    .description('Report whether the agents:// URL scheme handler is registered.')
    .action(() => {
      const status = agentsUrlSchemeStatus();
      const label = status.registered ? chalk.green('registered') : chalk.yellow('not registered');
      console.log(`agents:// handler: ${label} ${chalk.gray(`(${status.platform})`)}`);
      console.log(chalk.gray(`  ${status.detail}`));
      if (!status.registered) process.exitCode = 1;
    });
}

async function handleUrl(url: string): Promise<void> {
  const parsed = parseAgentsUrl(url);
  if ('error' in parsed) {
    console.error(chalk.red(`Not a valid agents:// link: ${parsed.error}`));
    process.exitCode = 2;
    return;
  }
  // Lazy-import the resume dispatcher so `register`/`status` stay cold-start cheap.
  const { dispatchSessionLifecycleInPlace } = await import('./sessions-resume.js');
  await dispatchSessionLifecycleInPlace(parsed.id, parsed.host ? [parsed.host] : []);
}
