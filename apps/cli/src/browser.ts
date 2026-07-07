#!/usr/bin/env node
import { Command } from 'commander';
import { registerBrowserSubcommands } from './commands/browser.js';

const program = new Command();
program.name('browser').description('Browser automation via CDP');
registerBrowserSubcommands(program);
program.parse();
