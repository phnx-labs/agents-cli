/**
 * PTY Commands
 *
 * CLI commands for managing interactive PTY sessions.
 * Auto-starts the sidecar server on first use.
 *
 * Usage:
 *   agents pty start [--rows 24 --cols 120 --shell zsh --cwd /path]
 *   agents pty exec  <id> <command>
 *   agents pty read  <id> [--ms 200]
 *   agents pty write <id> <input>
 *   agents pty screen <id>
 *   agents pty signal <id> [INT|TERM|KILL]
 *   agents pty list
 *   agents pty stop  <id>
 *   agents pty server [start|stop|status]
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { ptyRequest, unescapeInput } from '../lib/pty-client.js';
import { isPtyServerRunning, runPtyServer, getPtyPidPath, getPtyLogPath } from '../lib/pty-server.js';
import * as fs from 'fs';
import { setHelpSections } from '../lib/help.js';

/** Register the `agents pty` command tree. */
export function registerPtyCommands(program: Command): void {
  const pty = program
    .command('pty')
    .description('Drive interactive terminal programs from AI agents. Use this for REPLs, TUIs, or anything needing a real terminal.');

  setHelpSections(pty, {
    examples: `
      # Start a session (returns a session ID)
      SID=$(agents pty start)

      # Run a command (non-blocking)
      agents pty exec $SID "python3"

      # Wait, then see what's on screen (clean text, no ANSI)
      sleep 1 && agents pty screen $SID

      # Type input (supports escapes: \\n \\t \\e \\xHH)
      agents pty write $SID "print('hello')\\n"

      # Read again
      agents pty screen $SID

      # Clean up
      agents pty stop $SID
    `,
    notes: `
      Use cases:
        - Drive REPLs (python, node, irb) from agent code
        - Automate TUI programs (npm init, interactive wizards)
        - Test CLI tools that require a real PTY
        - Run the 'agents' CLI itself from another agent

      The PTY server auto-starts on first use and runs in the background.
      Health: 'agents pty server status'.
    `,
  });

  // --- Session lifecycle ---

  const startCmd = pty
    .command('start')
    .description('Start a new PTY session and return its ID. The session persists until you stop it.')
    .option('-r, --rows <n>', 'Terminal height in rows', '24')
    .option('-c, --cols <n>', 'Terminal width in columns', '120')
    .option('-s, --shell <shell>', 'Shell to launch (defaults to $SHELL, e.g., zsh, bash)')
    .option('-d, --cwd <dir>', 'Working directory for the shell')
    .option('--json', 'Output full session metadata as JSON');

  setHelpSections(startCmd, {
    examples: `
      # Start a session and capture its ID
      SID=$(agents pty start)

      # Start a Python REPL in a specific directory
      agents pty start --shell python3 --cwd /tmp

      # Start a wider terminal for TUI programs
      agents pty start --cols 160 --rows 40
    `,
  });

  startCmd.action(async (opts) => {
      const params: Record<string, any> = {
        rows: parseInt(opts.rows, 10),
        cols: parseInt(opts.cols, 10),
      };
      if (opts.shell) params.shell = opts.shell;
      if (opts.cwd) params.cwd = opts.cwd;

      const res = await ptyRequest('start', undefined, params);
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res));
      } else {
        console.log(res.id);
      }
    });

  const execCmd = pty
    .command('exec <id> <command>')
    .description('Send a command to a PTY session. Returns immediately (non-blocking). Use screen or read to see output.')
    .option('--wait <ms>', 'Wait this many milliseconds then return the screen (convenience for quick commands)', '0')
    .option('--json', 'Output as JSON');

  setHelpSections(execCmd, {
    examples: `
      # Run a command and return immediately
      agents pty exec $SID "ls -la"

      # Run a command and wait 500ms to see output
      agents pty exec $SID "git status" --wait 500

      # Start a long-running process (returns right away)
      agents pty exec $SID "npm run dev"
    `,
  });

  execCmd.action(async (id, command, opts) => {
      const res = await ptyRequest('exec', id, { command });
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      const waitMs = parseInt(opts.wait, 10);
      if (waitMs > 0) {
        // Wait then return screen
        await new Promise(r => setTimeout(r, waitMs));
        const screen = await ptyRequest('screen', id);
        if (opts.json) {
          console.log(JSON.stringify(screen));
        } else if (screen.ok) {
          console.log(screen.screen);
        }
      } else if (opts.json) {
        console.log(JSON.stringify(res));
      }
    });

  const readCmd = pty
    .command('read <id>')
    .description('Read raw output from the PTY (includes ANSI codes). Use screen for clean text instead.')
    .option('-m, --ms <ms>', 'Wait up to this many milliseconds for new output (50-5000)', '200')
    .option('--json', 'Output as JSON');

  setHelpSections(readCmd, {
    examples: `
      # Read pending output (wait up to 200ms)
      agents pty read $SID

      # Read with longer wait for slow commands
      agents pty read $SID --ms 1000
    `,
  });

  readCmd.action(async (id, opts) => {
      const ms = parseInt(opts.ms, 10);
      const res = await ptyRequest('read', id, { ms });
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res));
      } else {
        if (res.output) process.stdout.write(res.output);
      }
    });

  const writeCmd = pty
    .command('write <id> <input>')
    .description('Send keystrokes to the PTY (like typing into the terminal). Processes escape sequences by default.')
    .option('--raw', 'Send input literally without processing \\n \\t \\e \\xHH escape codes')
    .option('--json', 'Output as JSON');

  setHelpSections(writeCmd, {
    examples: `
      # Send Enter key
      agents pty write $SID "\\n"

      # Type a command and press Enter
      agents pty write $SID "ls -la\\n"

      # Send Ctrl-C (interrupt signal)
      agents pty write $SID "\\x03"

      # Send Escape key
      agents pty write $SID "\\e"

      # Send literal backslash-n (not newline)
      agents pty write $SID "\\\\n" --raw
    `,
  });

  writeCmd.action(async (id, input, opts) => {
      const processed = opts.raw ? input : unescapeInput(input);
      const res = await ptyRequest('write', id, { input: processed });
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res));
      }
    });

  const screenCmd = pty
    .command('screen <id>')
    .description('Render the terminal screen as clean text (no ANSI codes). This is what a human sees looking at the terminal.')
    .option('--json', 'Output as JSON (includes cursor position and dimensions)');

  setHelpSections(screenCmd, {
    examples: `
      # See what's currently on screen
      agents pty screen $SID

      # Get screen with cursor position as JSON
      agents pty screen $SID --json
    `,
    notes: `
      Use this (not read) when you want clean text for an LLM to parse.
    `,
  });

  screenCmd.action(async (id, opts) => {
      const res = await ptyRequest('screen', id);
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res));
      } else {
        console.log(res.screen);
      }
    });

  const signalCmd = pty
    .command('signal <id> [signal]')
    .description('Send a POSIX signal to the running process. Defaults to INT (Ctrl-C).');

  setHelpSections(signalCmd, {
    examples: `
      # Send Ctrl-C (interrupt)
      agents pty signal $SID INT

      # Terminate gracefully
      agents pty signal $SID TERM

      # Force kill
      agents pty signal $SID KILL
    `,
  });

  signalCmd.action(async (id, signal) => {
      const res = await ptyRequest('signal', id, { signal: signal || 'INT' });
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }
    });

  pty
    .command('resize <id>')
    .description('Resize a PTY session')
    .option('-r, --rows <n>', 'Terminal rows')
    .option('-c, --cols <n>', 'Terminal columns')
    .action(async (id, opts) => {
      const params: Record<string, any> = {};
      if (opts.rows) params.rows = parseInt(opts.rows, 10);
      if (opts.cols) params.cols = parseInt(opts.cols, 10);

      const res = await ptyRequest('resize', id, params);
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }
      console.log(`${res.cols}x${res.rows}`);
    });

  const stopCmd = pty
    .command('stop <id>')
    .description('Stop a PTY session and clean up. The session ID becomes invalid.');

  setHelpSections(stopCmd, {
    examples: `
      # Stop a session by ID
      agents pty stop $SID
    `,
  });

  stopCmd.action(async (id) => {
      const res = await ptyRequest('stop', id);
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }
    });

  // --- Session listing ---

  const listCmd = pty
    .command('list')
    .description('List all active PTY sessions (running or idle).')
    .option('--json', 'Output as JSON');

  setHelpSections(listCmd, {
    examples: `
      # List all active sessions
      agents pty list
    `,
  });

  listCmd.action(async (opts) => {
      const res = await ptyRequest('list');
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res.sessions));
        return;
      }

      if (res.sessions.length === 0) {
        console.log(chalk.gray('No active PTY sessions'));
        return;
      }

      for (const s of res.sessions) {
        const age = formatAge(Date.now() - s.started_at);
        const status = s.exited
          ? chalk.red(`exited (${s.exit_code})`)
          : s.app_active
            ? chalk.yellow(`running: ${s.active_command}`)
            : chalk.green('idle');

        console.log(`  ${chalk.bold(s.id)}  pid=${s.pid}  ${s.shell}  ${s.cols}x${s.rows}  ${age}  ${status}`);
        console.log(`    ${chalk.gray(s.cwd)}`);
      }
    });

  // --- Server management ---

  const serverCmd = pty
    .command('server')
    .description('Manage the PTY sidecar server (auto-starts on first use, usually you do not need this).');

  serverCmd
    .command('start')
    .description('Start the PTY server manually (auto-starts on first pty command anyway).')
    .action(async () => {
      if (isPtyServerRunning()) {
        const pidPath = getPtyPidPath();
        const pid = fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf-8').trim() : '?';
        console.log(chalk.yellow(`PTY server already running (PID: ${pid})`));
        return;
      }

      // Use ptyRequest which auto-starts the server
      const res = await ptyRequest('ping');
      if (res.ok) {
        console.log(chalk.green(`PTY server started (PID: ${res.pid})`));
      } else {
        console.error(chalk.red('Failed to start PTY server'));
        process.exit(1);
      }
    });

  serverCmd
    .command('stop')
    .description('Stop the PTY server and kill all active sessions.')
    .action(async () => {
      if (!isPtyServerRunning()) {
        console.log(chalk.yellow('PTY server is not running'));
        return;
      }

      const pidPath = getPtyPidPath();
      try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        process.kill(pid, 'SIGTERM');
        console.log(chalk.green('PTY server stopped'));
      } catch {
        console.error(chalk.red('Failed to stop PTY server'));
        process.exit(1);
      }
    });

  serverCmd
    .command('status')
    .description('Check if the PTY server is running and how many sessions are active.')
    .action(async () => {
      const running = isPtyServerRunning();
      console.log(`  Status: ${running ? chalk.green('running') : chalk.gray('stopped')}`);

      if (running) {
        try {
          const res = await ptyRequest('ping');
          if (res.ok) {
            console.log(`  PID:      ${res.pid}`);
            console.log(`  Sessions: ${res.sessions}`);
          }
        } catch {}
      }

      const logPath = getPtyLogPath();
      console.log(`  Log:    ${logPath}`);
    });

  // Internal: run server in foreground (spawned by auto-start)
  pty
    .command('_server', { hidden: true })
    .description('Run PTY server (internal)')
    .action(async () => {
      await runPtyServer();
    });
}

/** Format a millisecond duration as a compact human-readable string (e.g. "5m", "2h 30m"). */
function formatAge(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
