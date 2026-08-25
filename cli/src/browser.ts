#!/usr/bin/env node
import { Command } from 'commander';
import { registerBrowserSubcommands } from './commands/browser.js';
import { maybeRunStandaloneOnHost } from './lib/hosts/passthrough.js';

async function main(): Promise<void> {
  // `browser … --device <box>` routes to a remote over SSH, exactly like
  // `agents browser … --device <box>` does through index.ts. Standalone-only:
  // this binary never enters index.ts, so without this the flag was dropped.
  if (await maybeRunStandaloneOnHost('browser')) {
    process.exit(process.exitCode ?? 0);
  }

  const program = new Command();
  program.name('browser').description('Browser automation via CDP');
  registerBrowserSubcommands(program);
  program.parse();
}

void main();
