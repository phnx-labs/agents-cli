#!/usr/bin/env node
import { Command } from 'commander';
import { registerComputerSubcommands } from './commands/computer.js';

const program = new Command();
program.name('computer').description('Drive macOS apps via Accessibility — list, screenshot, click, type');
registerComputerSubcommands(program);
program.parse();
