/**
 * `agents _callback` — the machine-only OS callback for `agents://` deep links.
 *
 *   agents _callback agents://session/<id>    resume that session in a terminal
 *
 * This is NOT a user command: humans resume with `agents sessions resume`, and
 * manage the OS URL-scheme handler with `agents setup url-scheme`. The bare-URL
 * verb exists only because a rendered artifact (plan/report) embeds
 * `agents://session/<id>` in its provenance line; clicking it hands the URL to
 * the OS, which invokes the registered handler — `agents _callback <url>`. This
 * command parses it (lib/deeplink/url.ts) and hands the session id to the
 * existing resume dispatcher, which resolves the owning host and opens the
 * terminal with the cursor in the input bar. The id is passed as argv, never
 * interpolated into a shell.
 *
 * The command is hidden. `open` is kept as a HIDDEN alias so machines whose OS
 * handler was written by an older CLI (which emitted `agents open <url>`) keep
 * resolving until `agents setup url-scheme register` re-writes the handler to the
 * `_callback` verb. Dropping `open` would break every previously-registered link.
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
  const callback = program
    .command('_callback [url]', { hidden: true })
    .alias('open')
    .description('OS callback that resumes a session from an agents:// deep link (machine-only; humans use `agents sessions resume`).')
    .action(async (url: string | undefined) => {
      if (!url) {
        callback.help();
        return;
      }
      await handleUrl(url);
    });

  // Back-compat: `agents open register|unregister|status` still work as HIDDEN
  // subcommands (muscle memory + docs). The canonical, visible home is
  // `agents setup url-scheme <verb>`, which reuses the SAME builder below.
  addUrlSchemeSubcommands(callback, { hidden: true });
}

/**
 * Attach `register` / `unregister` / `status` subcommands that manage the
 * `agents://` OS URL-scheme handler onto `parent`. One implementation, mounted
 * both under the hidden `_callback` command (back-compat) and under the visible
 * `agents setup url-scheme` group.
 */
export function addUrlSchemeSubcommands(parent: Command, opts: { hidden?: boolean } = {}): void {
  const hidden = opts.hidden ?? false;

  parent
    .command('register', { hidden })
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

  parent
    .command('unregister', { hidden })
    .description('Remove the agents:// URL scheme handler.')
    .action(() => {
      const status = unregisterAgentsUrlScheme();
      console.log(chalk.gray(status.detail));
    });

  parent
    .command('status', { hidden })
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
