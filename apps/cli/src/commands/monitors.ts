/**
 * Monitors — durable event-triggered watchers.
 *
 * Registers the `agents monitors` command tree: create, list, view, dry-run test,
 * edit, logs, fire history, pause/resume, (re)pin the owner device, and remove.
 * Mirrors `agents routines` (commands/routines.ts) and shares the same daemon +
 * dispatch engine underneath — a monitor is a routine whose trigger is a watched
 * source instead of a clock.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  isDaemonRunning,
  signalDaemonReload,
  startDaemon,
} from '../lib/daemon.js';
import {
  listMonitors,
  readMonitor,
  writeMonitor,
  deleteMonitor,
  setMonitorEnabled,
  getMonitorPath,
  validateMonitor,
  monitorRunsOnThisDevice,
  type MonitorConfig,
  type MonitorSource,
  type MonitorSourceType,
  type MonitorCondition,
  type ActionConfig,
  type MonitorWebhookSource,
} from '../lib/monitors/config.js';
import { evaluateMonitorOnce } from '../lib/monitors/engine.js';
import { listFires, readState } from '../lib/monitors/state.js';
import { listRuns, getLatestRun, getRunDir } from '../lib/routines.js';
import { getMonitorsDir } from '../lib/state.js';
import { IS_WINDOWS } from '../lib/platform/index.js';
import { safeJoin } from '../lib/paths.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { loadDevices } from '../lib/devices/registry.js';
import { setHelpSections } from '../lib/help.js';
import { isInteractiveTerminal, requireInteractiveSelection } from './utils.js';

/** A one-line human label for what a monitor watches. */
function sourceLabel(source: MonitorSource): string {
  switch (source.type) {
    case 'command':
    case 'poll':
      return `${source.type}: ${source.command ?? ''}${source.interval ? ` @${source.interval}` : ''}`;
    case 'poll-http':
      return `poll-http: ${source.url ?? ''} @${source.interval ?? ''}`;
    case 'ws':
      return `ws: ${source.wsUrl ?? ''}`;
    case 'file':
      return `file: ${source.path ?? ''}`;
    case 'device':
      return `device: ${source.device ?? ''}`;
    case 'webhook':
      return `on ${source.webhook?.source}:${source.webhook?.event}`;
    default:
      return source.type;
  }
}

/** A one-line human label for a monitor's action. */
function actionLabel(action: ActionConfig): string {
  switch (action.type) {
    case 'run':
      return `run ${action.agent ?? ''}`;
    case 'routine':
      return `routine ${action.routine ?? ''}`;
    case 'notify':
      return `notify ${action.notifyChannel ?? 'telegram'}`;
    case 'webhook-out':
      return `webhook-out ${action.url ?? ''}`;
    default:
      return action.type;
  }
}

/** A one-line human label for a monitor's owner/allowlist placement. */
function ownerLabel(monitor: MonitorConfig): string {
  if (monitor.device) return monitor.device;
  if (monitor.devices && monitor.devices.length > 0) return monitor.devices.join(',');
  return 'all';
}

/** Start or reload the background daemon so a newly-added monitor is watched. */
function ensureDaemonRunning(): void {
  if (isDaemonRunning()) {
    signalDaemonReload();
    console.log(chalk.gray('Daemon reloaded'));
    return;
  }
  const result = startDaemon();
  if (result.pid) {
    console.log(chalk.green(`Daemon started (PID: ${result.pid}). It will watch monitors in the background.`));
    console.log(chalk.gray('Stop anytime with: agents routines stop'));
  } else {
    console.log(chalk.yellow('Could not start the daemon. Start it manually with: agents routines start'));
  }
}

/** Validate a single device name against the registered fleet; exit on miss. */
async function validateDevice(name: string): Promise<string> {
  const normalized = normalizeHost(name.trim());
  if (!normalized) {
    console.log(chalk.red('device name must be non-empty'));
    process.exit(1);
  }
  const registry = await loadDevices();
  const registered = new Set(Object.keys(registry).map((k) => normalizeHost(k)));
  if (!registered.has(normalized)) {
    console.log(chalk.red(`Unknown device: ${normalized}`));
    console.log(chalk.gray(`Registered: ${[...registered].sort().join(', ') || '(none)'}`));
    console.log(chalk.gray('Enroll devices with: agents devices sync'));
    process.exit(1);
  }
  return normalized;
}

/** Parse the source flags into a MonitorSource, exiting on missing/ambiguous input. */
function buildSource(options: Record<string, any>): MonitorSource {
  const chosen: Array<{ type: MonitorSourceType; source: MonitorSource }> = [];
  if (options.watch) chosen.push({ type: 'command', source: { type: 'command', command: options.watch } });
  if (options.poll) {
    chosen.push({ type: 'poll', source: { type: 'poll', command: options.poll[0], interval: options.poll[1] } });
  }
  if (options.pollHttp) {
    chosen.push({
      type: 'poll-http',
      source: { type: 'poll-http', url: options.pollHttp[0], interval: options.pollHttp[1] },
    });
  }
  if (options.ws) chosen.push({ type: 'ws', source: { type: 'ws', wsUrl: options.ws } });
  if (options.watchFile) chosen.push({ type: 'file', source: { type: 'file', path: options.watchFile } });
  if (options.watchDevice) {
    chosen.push({ type: 'device', source: { type: 'device', device: options.watchDevice } });
  }
  if (options.on) {
    const raw = String(options.on);
    const [src, event] = raw.includes(':') ? raw.split(':', 2) : ['github', raw];
    if (src !== 'github' && src !== 'linear') {
      console.log(chalk.red('--on source must be github or linear'));
      process.exit(1);
    }
    const webhook: MonitorWebhookSource = { source: src, event };
    if (options.repo) webhook.repo = options.repo;
    if (options.branch) webhook.branch = options.branch;
    if (options.action) webhook.action = options.action;
    if (options.teamKey) webhook.teamKey = options.teamKey;
    if (options.label) webhook.label = options.label;
    chosen.push({ type: 'webhook', source: { type: 'webhook', webhook } });
  }

  if (chosen.length === 0) {
    console.log(chalk.red('A source is required: --watch, --poll, --poll-http, --ws, --watch-file, --watch-device, or --on'));
    process.exit(1);
  }
  if (chosen.length > 1) {
    console.log(chalk.red(`Exactly one source is allowed; got ${chosen.map((c) => c.type).join(', ')}`));
    process.exit(1);
  }
  return chosen[0].source;
}

/** Parse the condition flags into a MonitorCondition (default on-change). */
function buildCondition(options: Record<string, any>): MonitorCondition {
  const modes: Array<MonitorCondition['mode']> = [];
  if (options.onChange) modes.push('on-change');
  if (options.match) modes.push('match');
  if (options.every) modes.push('every');
  if (modes.length > 1) {
    console.log(chalk.red('--on-change, --match, and --every are mutually exclusive'));
    process.exit(1);
  }
  const mode: MonitorCondition['mode'] = modes[0] ?? (options.match ? 'match' : 'on-change');
  const condition: MonitorCondition = { mode };
  if (options.match) condition.match = options.match;
  if (options.dedupeKey) condition.dedupeKey = options.dedupeKey;
  return condition;
}

/** Parse the action flags into an ActionConfig, exiting on missing/ambiguous input. */
function buildAction(options: Record<string, any>): ActionConfig {
  const chosen: ActionConfig[] = [];
  if (options.run) {
    const action: ActionConfig = { type: 'run', agent: options.run, prompt: options.prompt };
    if (options.mode) action.mode = options.mode;
    if (options.effort) action.effort = options.effort;
    if (options.actionTimeout) action.timeout = options.actionTimeout;
    chosen.push(action);
  }
  if (options.routine) chosen.push({ type: 'routine', routine: options.routine });
  if (options.notify !== undefined) {
    // --notify may be a bare flag (true) or carry a channel string.
    const channel = typeof options.notify === 'string' ? options.notify : 'telegram';
    chosen.push({ type: 'notify', notifyChannel: channel });
  }
  if (options.webhookOut) chosen.push({ type: 'webhook-out', url: options.webhookOut });

  if (chosen.length === 0) {
    console.log(chalk.red('An action is required: --run <agent> --prompt, --routine, --notify, or --webhook-out'));
    process.exit(1);
  }
  if (chosen.length > 1) {
    console.log(chalk.red(`Exactly one action is allowed; got ${chosen.map((c) => c.type).join(', ')}`));
    process.exit(1);
  }
  return chosen[0];
}

/** Interactive monitor picker. Returns the selected name or null on cancel/empty. */
async function pickMonitor(message: string, alternatives: string[] = []): Promise<string | null> {
  const monitors = listMonitors();
  if (monitors.length === 0) {
    console.log(chalk.yellow('No monitors configured'));
    return null;
  }
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(message.replace(/:$/, ''), alternatives);
  }
  try {
    const { select } = await import('@inquirer/prompts');
    return await select({
      message,
      choices: monitors.map((m) => ({
        value: m.name,
        name: `${m.name} ${chalk.gray(`(${sourceLabel(m.source)} → ${actionLabel(m.action)})`)}`,
      })),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'ExitPromptError' || err.message.includes('User force closed'))) {
      console.log(chalk.gray('Cancelled'));
      return null;
    }
    throw err;
  }
}

/** Register the `agents monitors` command tree. */
export function registerMonitorsCommands(program: Command): void {
  const monitorsCmd = program
    .command('monitors')
    .description('Durable event-triggered watchers: watch a source, detect a change, fire an action. The daemon auto-starts on first add.');

  setHelpSections(monitorsCmd, {
    examples: `
      # CI went red → triage it (poll a command, diff, fire an agent)
      agents monitors add ci-red \\
        --poll 'gh pr checks 1119 --json name,bucket' 30s --match 'fail' \\
        --run claude --prompt 'CI failed on #1119: {event}. Diagnose and fix.' \\
        --device yosemite-s0

      # SSL cert issued → notify (poll an HTTPS endpoint every 8h)
      agents monitors add cert-issued \\
        --poll-http 'https://secure.ssl.com/team/.../co-ec1l5dgjofa' 8h \\
        --match 'issued' --notify telegram --device zion

      # Dry-run: evaluate the source once and show what it would emit (no action)
      agents monitors test ci-red

      # A fleet box going loaded → spin up an agent
      agents monitors add box-loaded --watch-device yosemite-s0 --match loaded \\
        --run claude --prompt 'yosemite-s0 is loaded: {event}. Investigate.'
    `,
    notes: `
      A monitor is a routine whose trigger is a watched SOURCE instead of a clock.
      It has three parts:
        - SOURCE    (--watch, --poll, --poll-http, --ws, --watch-file, --watch-device, --on)
        - CONDITION (--on-change [default], --match <re>, --every; --dedupe-key)
        - ACTION    (--run <agent> --prompt, --routine, --notify, --webhook-out)

      The fired event is injected into a run/routine prompt as {event}.
      Pin the single OWNER device with --device (exactly-once). The daemon (shared
      with routines) auto-starts on first add; manage it with 'agents routines start|stop'.

      v1 evaluates poll sources (command, poll, poll-http, file, device). Push
      sources (ws, webhook) are accepted but delivered through a receiver wired in
      a follow-up.
    `,
  });

  // ─── add ────────────────────────────────────────────────────────────────────
  monitorsCmd
    .command('add [nameOrPath]')
    .description('Create a monitor from inline flags or a YAML file. Auto-starts the daemon.')
    // SOURCE
    .option('--watch <cmd>', 'Run a shell command; its stdout is the observation')
    .option('--poll <cmd...>', 'Re-run a command every interval: --poll "<cmd>" <interval> (e.g. 30s)')
    .option('--poll-http <url...>', 'GET a URL every interval: --poll-http <url> <interval> (e.g. 15m)')
    .option('--on <source:event>', 'Webhook trigger source: github:pull_request or linear:Issue')
    .option('--ws <url>', 'WebSocket; each frame is an observation')
    .option('--watch-file <path>', 'Watch a file or directory for changes')
    .option('--watch-device <name>', 'A fleet device becomes the source (health/reachability)')
    // webhook filters
    .option('--repo <owner/name>', 'GitHub repo filter for --on github:<event>')
    .option('--branch <name>', 'GitHub branch filter for --on github:<event>')
    .option('--action <name>', 'Linear action filter for --on linear:<event>')
    .option('--team-key <key>', 'Linear team key filter for --on linear:<event>')
    .option('--label <name>', 'Linear issue label filter for --on linear:Issue')
    // CONDITION
    .option('--on-change', 'Fire when the observation differs from last-seen (the default)')
    .option('--match <regex>', 'Fire when the observation matches this regex')
    .option('--dedupe-key <expr>', 'Regex whose first match is the "same event" signature (default: full output)')
    .option('--every', 'Fire on every observation (no dedupe) — rate-limit this')
    // ACTION
    .option('--run <agent>', 'Spawn an agent (claude, codex, ...) with the prompt on fire')
    .option('--prompt <prompt>', 'Prompt for --run; {event} is replaced with the fired event')
    .option('--mode <mode>', 'Execution mode for --run: plan, edit, auto, or skip')
    .option('--effort <effort>', 'Reasoning effort for --run: low | medium | high | xhigh | max | auto')
    .option('--action-timeout <t>', 'Kill the --run action if it runs longer than this (e.g. 10m)')
    .option('--routine <name>', 'Fire an existing routine on change')
    .option('--notify [channel]', 'Send a notification (default channel: telegram)')
    .option('--webhook-out <url>', 'POST the event to this URL')
    // PLACEMENT / hygiene
    .option('--device <name>', 'OWNER device — the single machine that evaluates + fires (exactly-once)')
    .option('--devices <list>', 'Allowlist (comma-separated): each device fires independently')
    .option('--run-on <host>', 'Execute the ACTION on this machine over SSH (placement)')
    .option('--rate-limit <spec>', 'Auto-pause if it fires more than N/<interval> (e.g. 5/1m)')
    .option('--disabled', 'Create the monitor paused (enable later with resume)')
    .action(async (nameOrPath: string | undefined, options: Record<string, any>) => {
      // File mode: a single arg pointing at an existing .yml with no source flags.
      const hasSourceFlag = Boolean(
        options.watch || options.poll || options.pollHttp || options.on || options.ws || options.watchFile || options.watchDevice,
      );
      if (!hasSourceFlag && nameOrPath && /\.ya?ml$/.test(nameOrPath) && fs.existsSync(path.resolve(nameOrPath))) {
        const resolved = path.resolve(nameOrPath);
        let parsed: any;
        try {
          parsed = yaml.parse(fs.readFileSync(resolved, 'utf-8'));
        } catch (err) {
          console.log(chalk.red(`Invalid YAML: ${(err as Error).message}`));
          process.exit(1);
        }
        const name = parsed?.name || path.basename(resolved).replace(/\.ya?ml$/, '');
        const config: MonitorConfig = { enabled: true, ...parsed, name } as MonitorConfig;
        const errors = validateMonitor(config);
        if (errors.length > 0) {
          console.log(chalk.red('Validation errors:'));
          for (const err of errors) console.log(chalk.red(`  - ${err}`));
          process.exit(1);
        }
        writeMonitor(config);
        console.log(chalk.green(`Monitor '${name}' added`));
        ensureDaemonRunning();
        return;
      }

      if (!nameOrPath) {
        console.log(chalk.red('Monitor name is required'));
        console.log(chalk.gray('Usage: agents monitors add <name> --poll "<cmd>" 30s --match fail --run claude --prompt "..."'));
        process.exit(1);
      }

      const source = buildSource(options);
      const condition = buildCondition(options);
      const action = buildAction(options);

      // Placement.
      let device: string | undefined;
      let devices: string[] | undefined;
      if (options.device && options.devices) {
        console.log(chalk.red('--device (single owner) and --devices (allowlist) are mutually exclusive'));
        process.exit(1);
      }
      if (options.device) device = await validateDevice(options.device);
      if (options.devices) {
        devices = [];
        for (const d of String(options.devices).split(',').map((s) => s.trim()).filter(Boolean)) {
          devices.push(await validateDevice(d));
        }
      }
      // --run-on with no owner pin would fire from every daemon → duplicate actions.
      if (options.runOn && !device && !devices) {
        device = machineId();
        console.log(chalk.gray(`--run-on set with no --device/--devices: pinned owner to this machine (${device}).`));
      }

      let rateLimit: MonitorConfig['rateLimit'];
      if (options.rateLimit) {
        const m = String(options.rateLimit).match(/^(\d+)\/(.+)$/);
        if (!m) {
          console.log(chalk.red('--rate-limit must be N/<interval>, e.g. 5/1m'));
          process.exit(1);
        }
        rateLimit = { max: parseInt(m[1], 10), per: m[2] };
      }

      const config: MonitorConfig = {
        name: nameOrPath,
        enabled: !options.disabled,
        source,
        condition,
        action,
        ...(device ? { device } : {}),
        ...(devices ? { devices } : {}),
        ...(options.runOn ? { runOn: options.runOn } : {}),
        ...(rateLimit ? { rateLimit } : {}),
      };

      const errors = validateMonitor(config);
      if (errors.length > 0) {
        console.log(chalk.red('Validation errors:'));
        for (const err of errors) console.log(chalk.red(`  - ${err}`));
        process.exit(1);
      }

      // Coverage lint (Anthropic's "silence is not success"): warn when a --match
      // names only a success-shaped token with no failure branch.
      if (condition.mode === 'match' && condition.match && /^(issued|success|ok|pass(ed)?|done|ready)$/i.test(condition.match)) {
        console.log(chalk.yellow(`  Note: --match '${condition.match}' only fires on success — it stays silent if the source breaks or never matches.`));
      }

      writeMonitor(config);
      console.log(chalk.green(`Monitor '${nameOrPath}' added`));
      console.log(chalk.gray(`  ${sourceLabel(source)} → [${condition.mode}] → ${actionLabel(action)} · owner: ${ownerLabel(config)}`));
      ensureDaemonRunning();
    });

  // ─── list ────────────────────────────────────────────────────────────────────
  monitorsCmd
    .command('list')
    .description('See all monitors: source, condition, action, owner, and last fire.')
    .option('--json', 'Emit machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const monitors = listMonitors();
      if (options.json) {
        const payload = monitors.map((m) => {
          const state = readState(m.name);
          return {
            name: m.name,
            enabled: m.enabled,
            source: m.source,
            condition: m.condition,
            action: { type: m.action.type },
            owner: ownerLabel(m),
            runsHere: monitorRunsOnThisDevice(m),
            lastSeenAt: state?.lastSeenAt ?? null,
            lastFiredAt: state?.lastFiredAt ?? null,
          };
        });
        process.stdout.write(JSON.stringify(payload) + '\n');
        return;
      }
      if (monitors.length === 0) {
        console.log(chalk.gray('No monitors configured'));
        console.log(chalk.gray('  Add one: agents monitors add <name> --poll "<cmd>" 30s --match fail --run claude --prompt "..."'));
        return;
      }
      console.log(chalk.bold('Monitors\n'));
      for (const m of monitors) {
        const state = readState(m.name);
        const enabled = m.enabled ? chalk.green('on') : chalk.gray('off');
        const here = monitorRunsOnThisDevice(m);
        const owner = here ? ownerLabel(m) : chalk.gray(ownerLabel(m));
        const lastFired = state?.lastFiredAt ? `fired ${state.lastFiredAt}` : chalk.gray('never fired');
        console.log(`  ${chalk.cyan(m.name.padEnd(22))} ${enabled.padEnd(3)} ${sourceLabel(m.source)}`);
        console.log(`  ${' '.repeat(22)}     ${chalk.gray(`[${m.condition.mode}]`)} → ${actionLabel(m.action)}  ${chalk.gray(`owner: ${owner}`)}  ${chalk.gray(lastFired)}`);
      }
      console.log();
    });

  // ─── view ──────────────────────────────────────────────────────────────────
  monitorsCmd
    .command('view [name]')
    .description('Show a monitor’s full YAML config plus its current watched-state and recent fires.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to view', ['agents monitors view <name>'])) ?? undefined;
        if (!name) return;
      }
      const monitor = readMonitor(name);
      if (!monitor) {
        console.log(chalk.red(`Monitor '${name}' not found`));
        process.exit(1);
      }
      console.log(chalk.bold(`Monitor: ${name}\n`));
      console.log(yaml.stringify(monitor));
      const state = readState(name);
      if (state) {
        console.log(chalk.bold('Watched state'));
        console.log(chalk.gray(`  last seen:  ${state.lastSeenAt}`));
        if (state.lastFiredAt) console.log(chalk.gray(`  last fired: ${state.lastFiredAt}`));
        console.log(chalk.gray(`  last value: ${state.lastValue.replace(/\s+/g, ' ').slice(0, 120)}`));
      }
      const fires = listFires(name).slice(-5);
      if (fires.length > 0) {
        console.log(chalk.bold('\nRecent fires'));
        for (const f of fires) {
          console.log(`  ${chalk.gray(f.firedAt)}  ${f.action ?? '?'}  ${f.ok === false ? chalk.red('failed') : chalk.green('ok')}`);
        }
      }
    });

  // ─── test (DRY RUN) ───────────────────────────────────────────────────────────
  monitorsCmd
    .command('test [name]')
    .description('DRY-RUN: evaluate the source once and print the emitted event + whether it would fire. No action is taken.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to test', ['agents monitors test <name>'])) ?? undefined;
        if (!name) return;
      }
      const monitor = readMonitor(name);
      if (!monitor) {
        console.log(chalk.red(`Monitor '${name}' not found`));
        process.exit(1);
      }
      console.log(chalk.bold(`Dry-run: ${name}\n`));
      console.log(chalk.gray(`  ${sourceLabel(monitor.source)}  ·  [${monitor.condition.mode}]  ·  ${actionLabel(monitor.action)}\n`));

      const { observation, decision } = await evaluateMonitorOnce(monitor);
      if (!observation) {
        console.log(chalk.yellow('No observation — this source is push-only (ws/webhook) or produced nothing this tick.'));
        return;
      }
      console.log(chalk.bold('Observation'));
      console.log(observation.raw.split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
      if (observation.meta) console.log(chalk.gray(`  meta: ${JSON.stringify(observation.meta)}`));

      const wouldFire = Boolean(decision?.fire);
      console.log('');
      console.log(`Would fire: ${wouldFire ? chalk.green('yes') : chalk.gray('no')}`);
      if (decision?.event) {
        console.log(chalk.bold('\nEmitted event'));
        console.log(`  summary: ${decision.event.summary}`);
        console.log(chalk.gray(`  → would ${actionLabel(monitor.action)}`));
      } else if (!wouldFire && monitor.condition.mode === 'on-change' && !readState(name)) {
        console.log(chalk.gray('  (first observation establishes a baseline; a later change fires)'));
      }
      console.log(chalk.gray('\n(dry run — no action taken, no state written)'));
    });

  // ─── edit ─────────────────────────────────────────────────────────────────────
  monitorsCmd
    .command('edit [name]')
    .description('Open a monitor’s YAML in $EDITOR.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to edit', ['agents monitors edit <name>'])) ?? undefined;
        if (!name) return;
      }
      let monitorPath = getMonitorPath(name);
      if (!monitorPath) {
        const dir = getMonitorsDir();
        fs.mkdirSync(dir, { recursive: true });
        monitorPath = safeJoin(dir, `${name}.yml`);
        const template = yaml.stringify({
          name,
          source: { type: 'poll', command: 'echo hello', interval: '1m' },
          condition: { mode: 'on-change' },
          action: { type: 'notify', notifyChannel: 'telegram' },
        });
        fs.writeFileSync(monitorPath, template, 'utf-8');
        console.log(chalk.gray(`Created new monitor file: ${monitorPath}`));
      }
      const editor = process.env.EDITOR || process.env.VISUAL || (IS_WINDOWS ? 'notepad' : 'vi');
      const parts = editor.split(/\s+/).filter(Boolean);
      const { spawn } = await import('child_process');
      const child = spawn(parts[0], [...parts.slice(1), monitorPath], { stdio: 'inherit' });
      child.on('close', (code) => {
        if (code !== 0) return;
        const monitor = readMonitor(name!);
        if (!monitor) return;
        const errors = validateMonitor(monitor);
        if (errors.length > 0) {
          console.log(chalk.yellow('\nWarning: monitor has validation errors:'));
          for (const err of errors) console.log(chalk.yellow(`  - ${err}`));
        } else {
          console.log(chalk.green(`\nMonitor '${name}' saved`));
          if (isDaemonRunning()) {
            signalDaemonReload();
            console.log(chalk.gray('Daemon reloaded'));
          }
        }
      });
    });

  // ─── logs (action run history) ─────────────────────────────────────────────────
  monitorsCmd
    .command('logs [name]')
    .description('Show the latest action run’s status + report. --run for a specific run, --full for raw stdout.')
    .option('-r, --run <runId>', 'Show a specific action run instead of the latest')
    .option('-m, --full', 'Show the full raw stdout stream')
    .action(async (name: string | undefined, options: { run?: string; full?: boolean }) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to view logs', ['agents monitors logs <name>'])) ?? undefined;
        if (!name) return;
      }
      const run = options.run ? listRuns(name).find((r) => r.runId === options.run) : getLatestRun(name);
      if (!run) {
        console.log(chalk.yellow(`No action runs found for monitor '${name}'`));
        console.log(chalk.gray('  (notify / webhook-out actions have no run log — see: agents monitors runs)'));
        return;
      }
      const logPath = path.join(getRunDir(name, run.runId), 'stdout.log');
      if (options.full) {
        if (!fs.existsSync(logPath)) {
          console.log(chalk.yellow(`Log not found: ${logPath}`));
          return;
        }
        console.log(chalk.gray(`Run: ${run.runId}\n`));
        console.log(fs.readFileSync(logPath, 'utf-8'));
        return;
      }
      const statusColor = run.status === 'completed' ? chalk.green : run.status === 'running' ? chalk.yellow : chalk.red;
      console.log(chalk.bold(name) + chalk.gray(`  run ${run.runId}`));
      console.log(statusColor(run.status) + chalk.gray(`  ${run.startedAt}`));
      console.log(chalk.gray('─'.repeat(60)));
      const reportPath = path.join(getRunDir(name, run.runId), 'report.md');
      if (fs.existsSync(reportPath)) {
        console.log(fs.readFileSync(reportPath, 'utf-8').trimEnd());
      } else if (fs.existsSync(logPath)) {
        console.log(fs.readFileSync(logPath, 'utf-8').split('\n').slice(-40).join('\n').trimEnd());
      } else {
        console.log(chalk.gray('(no output captured)'));
      }
    });

  // ─── runs (fire history) ────────────────────────────────────────────────────────
  monitorsCmd
    .command('runs [name]')
    .description('See a monitor’s fire history: when it fired, the action, and the outcome.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to view fires', ['agents monitors runs <name>'])) ?? undefined;
        if (!name) return;
      }
      const fires = listFires(name);
      if (fires.length === 0) {
        console.log(chalk.yellow(`No fires recorded for monitor '${name}'`));
        return;
      }
      console.log(chalk.bold(`Fire history: ${name}\n`));
      for (const f of fires.slice(-20)) {
        const outcome = f.ok === false ? chalk.red('failed') : chalk.green('ok');
        const runRef = f.runId ? chalk.gray(`  run ${f.runId}`) : '';
        console.log(`  ${f.firedAt}  ${(f.action ?? '?').padEnd(12)} ${outcome}${runRef}`);
        console.log(chalk.gray(`    ${f.summary.slice(0, 100)}`));
      }
    });

  // ─── pause / resume ───────────────────────────────────────────────────────────
  monitorsCmd
    .command('pause [name]')
    .description('Temporarily disable a monitor. Stops watching until resumed.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to pause', ['agents monitors pause <name>'])) ?? undefined;
        if (!name) return;
      }
      try {
        setMonitorEnabled(name, false);
        console.log(chalk.green(`Monitor '${name}' paused`));
        if (isDaemonRunning()) signalDaemonReload();
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  monitorsCmd
    .command('resume [name]')
    .description('Re-enable a paused monitor so the daemon watches it again.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to resume', ['agents monitors resume <name>'])) ?? undefined;
        if (!name) return;
      }
      try {
        setMonitorEnabled(name, true);
        console.log(chalk.green(`Monitor '${name}' resumed`));
        if (isDaemonRunning()) signalDaemonReload();
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  // ─── device (re-pin the owner) ──────────────────────────────────────────────────
  monitorsCmd
    .command('device [name]')
    .description('View or (re)pin the OWNER device — the single machine that evaluates + fires (exactly-once).')
    .option('--set <name>', 'Pin the owner to this device (strict fleet validation)')
    .option('--clear', 'Remove the owner pin so the monitor runs on every device')
    .action(async (name: string | undefined, options: { set?: string; clear?: boolean }) => {
      if (options.set !== undefined && options.clear) {
        console.log(chalk.red('--set and --clear are mutually exclusive'));
        process.exit(1);
      }
      if (!name) {
        name = (await pickMonitor('Select monitor', ['agents monitors device <name> --set X'])) ?? undefined;
        if (!name) return;
      }
      const monitor = readMonitor(name);
      if (!monitor) {
        console.log(chalk.red(`Monitor '${name}' not found`));
        process.exit(1);
      }
      if (options.clear) {
        monitor.device = undefined;
        monitor.devices = undefined;
        writeMonitor(monitor);
        console.log(chalk.green(`Owner cleared for '${name}' — evaluates on every device`));
        if (isDaemonRunning()) signalDaemonReload();
        return;
      }
      if (options.set !== undefined) {
        const device = await validateDevice(options.set);
        monitor.device = device;
        monitor.devices = undefined;
        writeMonitor(monitor);
        console.log(chalk.green(`Owner for '${name}' set to: ${device}`));
        if (isDaemonRunning()) signalDaemonReload();
        return;
      }
      console.log(`Owner for '${name}': ${chalk.cyan(ownerLabel(monitor))}`);
      console.log(chalk.gray('  Re-pin with: agents monitors device ' + name + ' --set <device>'));
    });

  // ─── remove ────────────────────────────────────────────────────────────────────
  monitorsCmd
    .command('remove [name]')
    .description('Delete a monitor. Stops watching; past fire history remains on disk.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to remove', ['agents monitors remove <name>'])) ?? undefined;
        if (!name) return;
      }
      if (deleteMonitor(name)) {
        console.log(chalk.green(`Monitor '${name}' removed`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } else {
        console.log(chalk.red(`Monitor '${name}' not found`));
        process.exit(1);
      }
    });
}
