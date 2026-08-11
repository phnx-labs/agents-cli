/**
 * Lazy command registry.
 *
 * The CLI entry point (src/index.ts) used to statically import every command
 * module and call its `registerXCommand(program)` on every invocation. That
 * loaded the entire command tree (~50 modules) before the first line of output,
 * dominating cold-start latency.
 *
 * This module maps each user-typed top-level command name to a thunk that
 * dynamically imports ONLY the module(s) that command needs. Fast commands
 * (`--version`, `view`, ...) now pay for just the one module they use; the full
 * tree is loaded only on the rare slow paths (unknown-command spellcheck, bare
 * help) via `registerAllEagerCommands` in src/index.ts.
 *
 * Parity is non-negotiable: the name -> loader map below mirrors exactly which
 * module registers which top-level command on `main`. Multi-command modules
 * (versions, packages) map several names to the same loader; `prune` needs BOTH
 * versions (which creates `prune <specs...>`) and prune.js (which attaches the
 * `cleanup` subcommand to it), in that order — see commands/prune.ts.
 */
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configureRootCommand } from './root-command.js';

/** A function that registers one or more commands onto the root program. */
export type Registrar = (program: Command) => void;

/** A thunk that dynamically imports a command module and returns its registrar. */
export type ModuleLoader = () => Promise<Registrar>;

// One loader per command module. Each dynamically imports the module and hands
// back its register function. Kept as named consts so src/index.ts can compose
// them into the exact main-branch registration order for the slow path.
export const loadView: ModuleLoader = async () => (await import('../../commands/view.js')).registerViewCommand;
export const loadInspect: ModuleLoader = async () => (await import('../../commands/inspect.js')).registerInspectCommand;
export const loadFeedback: ModuleLoader = async () => (await import('../../commands/feedback.js')).registerFeedbackCommand;
export const loadCommands: ModuleLoader = async () => (await import('../../commands/commands.js')).registerCommandsCommands;
export const loadHooks: ModuleLoader = async () => (await import('../../commands/hooks.js')).registerHooksCommands;
export const loadSkills: ModuleLoader = async () => (await import('../../commands/skills.js')).registerSkillsCommands;
export const loadRules: ModuleLoader = async () => (await import('../../commands/rules.js')).registerRulesCommands;
export const loadMemory: ModuleLoader = async () => (await import('../../commands/memory.js')).registerMemoryCommands;
export const loadPermissions: ModuleLoader = async () => (await import('../../commands/permissions.js')).registerPermissionsCommands;
export const loadMcp: ModuleLoader = async () => (await import('../../commands/mcp.js')).registerMcpCommands;
export const loadCli: ModuleLoader = async () => (await import('../../commands/cli.js')).registerCliCommands;
export const loadSubagents: ModuleLoader = async () => (await import('../../commands/subagents.js')).registerSubagentsCommands;
export const loadPlugins: ModuleLoader = async () => (await import('../../commands/plugins.js')).registerPluginsCommands;
export const loadWorkflows: ModuleLoader = async () => (await import('../../commands/workflows.js')).registerWorkflowsCommands;
export const loadVersions: ModuleLoader = async () => (await import('../../commands/versions.js')).registerVersionsCommands;
export const loadUpdate: ModuleLoader = async () => (await import('../../commands/update.js')).registerUpdateCommand;
export const loadImport: ModuleLoader = async () => (await import('../../commands/import.js')).registerImportCommand;
export const loadPackages: ModuleLoader = async () => (await import('../../commands/packages.js')).registerPackagesCommands;
export const loadRoutines: ModuleLoader = async () => (await import('../../commands/routines.js')).registerRoutinesCommands;
export const loadMonitors: ModuleLoader = async () => (await import('../../commands/monitors.js')).registerMonitorsCommands;
export const loadProjects: ModuleLoader = async () => (await import('../../commands/projects.js')).registerProjectsCommands;
export const loadRun: ModuleLoader = async () => (await import('../../commands/exec.js')).registerRunCommand;
export const loadResume: ModuleLoader = async () => (await import('../../commands/resume.js')).registerResumeCommand;
export const loadOpen: ModuleLoader = async () => (await import('../../commands/open.js')).registerOpenCommand;
export const loadReconnect: ModuleLoader = async () => (await import('../../commands/reconnect.js')).registerReconnectCommand;
export const loadFork: ModuleLoader = async () => (await import('../../commands/fork.js')).registerForkCommand;
export const loadConfig: ModuleLoader = async () => (await import('../../commands/config.js')).registerConfigCommand;
export const loadModels: ModuleLoader = async () => (await import('../../commands/models.js')).registerModelsCommand;
export const loadModes: ModuleLoader = async () => (await import('../../commands/modes.js')).registerModesCommand;
export const loadPrune: ModuleLoader = async () => (await import('../../commands/prune.js')).registerPruneCommand;
export const loadTrash: ModuleLoader = async () => (await import('../../commands/trash.js')).registerTrashCommands;
export const loadRestore: ModuleLoader = async () => (await import('../../commands/trash.js')).registerRestoreCommand;
export const loadDoctor: ModuleLoader = async () => (await import('../../commands/doctor.js')).registerDoctorCommand;
export const loadApply: ModuleLoader = async () => (await import('../../commands/apply.js')).registerApplyCommand;
export const loadStatus: ModuleLoader = async () => (await import('../../commands/status.js')).registerStatusCommand;
export const loadSnapshot: ModuleLoader = async () => (await import('../../commands/snapshot.js')).registerSnapshotCommand;
export const loadProfiles: ModuleLoader = async () => (await import('../../commands/profiles.js')).registerProfilesCommands;
export const loadHarness: ModuleLoader = async () => (await import('../../commands/harness.js')).registerHarnessCommands;
export const loadSecrets: ModuleLoader = async () => (await import('../../commands/secrets.js')).registerSecretsCommands;
export const loadLogin: ModuleLoader = async () => (await import('../../commands/login.js')).registerLoginCommands;
export const loadMenubar: ModuleLoader = async () => (await import('../../commands/menubar.js')).registerMenubarCommands;
export const loadBeta: ModuleLoader = async () => (await import('../../commands/beta.js')).registerBetaCommands;
export const loadSync: ModuleLoader = async () => (await import('../../commands/sync.js')).registerSyncCommand;
export const loadRefreshRules: ModuleLoader = async () => (await import('../../commands/refresh-rules.js')).registerRefreshRulesCommand;
export const loadFactory: ModuleLoader = async () => (await import('../../commands/factory.js')).registerFactoryCommands;
export const loadUsage: ModuleLoader = async () => (await import('../../commands/usage.js')).registerUsageCommand;
export const loadCost: ModuleLoader = async () => (await import('../../commands/cost.js')).registerCostCommand;
export const loadInsights: ModuleLoader = async () => (await import('../../commands/insights.js')).registerInsightsCommand;
export const loadPerf: ModuleLoader = async () => (await import('../../commands/perf.js')).registerPerfCommand;
export const loadBench: ModuleLoader = async () => (await import('../../commands/bench.js')).registerBenchCommand;
// Thin deprecated alias of `agents insights mix` — no second mix implementation.
export const loadTrends: ModuleLoader = async () => (await import('../../commands/trends.js')).registerTrendsCommand;
export const loadOutput: ModuleLoader = async () => (await import('../../commands/output.js')).registerOutputCommand;
export const loadBudget: ModuleLoader = async () => (await import('../../commands/budget.js')).registerBudgetCommand;
export const loadAlias: ModuleLoader = async () => (await import('../../commands/alias.js')).registerAliasCommand;
export const loadMine: ModuleLoader = async () => (await import('../../commands/mine.js')).registerMineCommand;
export const loadPty: ModuleLoader = async () => (await import('../../commands/pty.js')).registerPtyCommands;
export const loadTmux: ModuleLoader = async () => (await import('../../commands/tmux.js')).registerTmuxCommands;
export const loadWatchdog: ModuleLoader = async () => (await import('../../commands/watchdog.js')).registerWatchdogCommand;
export const loadBrowser: ModuleLoader = async () => (await import('../../commands/browser.js')).registerBrowserCommand;
export const loadComputer: ModuleLoader = async () => (await import('../../commands/computer.js')).registerComputerCommand;
export const loadLogs: ModuleLoader = async () => (await import('../../commands/logs.js')).registerLogsCommand;
export const loadEvents: ModuleLoader = async () => (await import('../../commands/events.js')).registerEventsCommand;
export const loadSsh: ModuleLoader = async () => (await import('../../commands/ssh.js')).registerSshCommands;
export const loadRepo: ModuleLoader = async () => (await import('../../commands/repo.js')).registerRepoCommands;
export const loadSetup: ModuleLoader = async () => (await import('../../commands/setup.js')).registerSetupCommand;
export const loadUninstall: ModuleLoader = async () => (await import('../../commands/uninstall.js')).registerUninstallCommands;
export const loadUpgrade: ModuleLoader = async () => (await import('../../commands/upgrade.js')).registerUpgradeCommand;
export const loadSessions: ModuleLoader = async () => (await import('../../commands/sessions.js')).registerSessionsCommands;
export const loadTeams: ModuleLoader = async () => (await import('../../commands/teams.js')).registerTeamsCommands;
export const loadTickets: ModuleLoader = async () => (await import('../../commands/tickets.js')).registerTicketsCommand;
export const loadCloud: ModuleLoader = async () => (await import('../../commands/cloud.js')).registerCloudCommands;
export const loadMessage: ModuleLoader = async () => (await import('../../commands/message.js')).registerMessageCommand;
export const loadSend: ModuleLoader = async () => (await import('../../commands/send.js')).registerSendCommand;
export const loadFeed: ModuleLoader = async () => (await import('../../commands/feed.js')).registerFeedCommand;
export const loadMailboxes: ModuleLoader = async () => (await import('../../commands/mailboxes.js')).registerMailboxesCommand;
export const loadServe: ModuleLoader = async () => (await import('../../commands/serve.js')).registerServeCommand;
// Registers the `artifacts` group (with `share` + `setup` under it) AND the
// top-level `unshare` alias — see commands/artifacts.ts.
export const loadArtifacts: ModuleLoader = async () => (await import('../../commands/artifacts.js')).registerArtifactsCommands;
export const loadAudit: ModuleLoader = async () => (await import('../../commands/audit.js')).registerAuditCommands;
export const loadWebhooks: ModuleLoader = async () => (await import('../../commands/webhook.js')).registerWebhooksCommand;
export const loadHumans: ModuleLoader = async () => (await import('../../commands/humans.js')).registerHumansCommands;
export const loadAccounts: ModuleLoader = async () => (await import('../../commands/accounts.js')).registerAccountsCommand;
export const loadDaemon: ModuleLoader = async () => (await import('../../commands/daemon.js')).registerDaemonCommand;
export const loadCp: ModuleLoader = async () => (await import('../../commands/cp.js')).registerCpCommand;

/**
 * Commands whose modules pull in the SQLite-backed session/cloud stack. They are
 * registered AFTER `applyGlobalHelpConventions` (mirroring main's order: help
 * conventions at module top-level, lazy registration just before parse), so they
 * inherit the root's custom help formatter rather than getting the per-command
 * recursive pass. Keeping that ordering preserves their `--help` output exactly.
 */
// `roster` is an observe-umbrella alias of `sessions --active` — same module,
// same SQLite stack, same post-help registration order as sessions.
export const LAZY_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'sessions',
  'resume',
  'reconnect',
  'roster',
  'teams',
  'cloud',
  'message',
  'serve',
]);

/**
 * User-typed top-level command name -> ordered list of module loaders to run.
 *
 * Most names map to a single loader. The exceptions encode real coupling on main:
 *  - `add`/`use`/`list`/`remove`/`rm`/`purge` all come from the versions module.
 *  - `registry`/`search`/`install` all come from the packages module.
 *  - `trash` and `restore` are separate registrars in the trash module.
 *  - `prune` needs versions FIRST (it creates `prune <specs...>`) then prune.js
 *    (which finds that command and attaches the `cleanup` subcommand).
 *
 * Inline deprecated aliases (memory/perms/exec/jobs/cron) and the inline
 * `upgrade` command are NOT here — they are closures over entry-point state and
 * are handled directly in src/index.ts.
 */
export const COMMAND_LOADERS: Record<string, ModuleLoader[]> = {
  accounts: [loadAccounts],
  view: [loadView],
  inspect: [loadInspect],
  feedback: [loadFeedback],
  commands: [loadCommands],
  hooks: [loadHooks],
  skills: [loadSkills],
  rules: [loadRules],
  memory: [loadMemory],
  permissions: [loadPermissions],
  mcp: [loadMcp],
  clis: [loadCli],
  subagents: [loadSubagents],
  plugins: [loadPlugins],
  workflows: [loadWorkflows],
  add: [loadVersions],
  use: [loadVersions],
  list: [loadVersions],
  remove: [loadVersions],
  rm: [loadVersions],
  purge: [loadVersions],
  update: [loadUpdate],
  prune: [loadVersions, loadPrune],
  import: [loadImport],
  registry: [loadPackages],
  search: [loadPackages],
  install: [loadPackages],
  routines: [loadRoutines],
  monitors: [loadMonitors],
  projects: [loadProjects],
  run: [loadRun],
  resume: [loadResume],
  open: [loadOpen],
  reconnect: [loadReconnect],
  fork: [loadFork],
  config: [loadConfig],
  models: [loadModels],
  modes: [loadModes],
  trash: [loadTrash],
  restore: [loadRestore],
  doctor: [loadDoctor],
  apply: [loadApply],
  status: [loadStatus],
  snapshot: [loadSnapshot],
  profiles: [loadProfiles],
  harness: [loadHarness],
  harnesses: [loadHarness],
  secrets: [loadSecrets],
  login: [loadLogin],
  logout: [loadLogin],
  menubar: [loadMenubar],
  beta: [loadBeta],
  sync: [loadSync],
  'refresh-rules': [loadRefreshRules],
  factory: [loadFactory],
  usage: [loadUsage],
  cost: [loadCost],
  insights: [loadInsights],
  perf: [loadPerf],
  bench: [loadBench],
  trends: [loadTrends],
  output: [loadOutput],
  budget: [loadBudget],
  alias: [loadAlias],
  mine: [loadMine],
  pty: [loadPty],
  tmux: [loadTmux],
  watchdog: [loadWatchdog],
  browser: [loadBrowser],
  computer: [loadComputer],
  logs: [loadLogs],
  events: [loadEvents],
  ssh: [loadSsh],
  devices: [loadSsh],
  // `fleet` is a commander alias of `devices` (see commands/ssh.ts); list it so
  // lazy registration loads the devices tree when the user types `agents fleet`.
  fleet: [loadSsh],
  // `repos` is the canonical command name; `repo` remains a convenience alias
  // (see commands/repo.ts). List both so lazy registration loads the tree
  // whichever the user types.
  repos: [loadRepo],
  repo: [loadRepo],
  setup: [loadSetup],
  uninstall: [loadUninstall],
  upgrade: [loadUpgrade],
  sessions: [loadSessions],
  // Observe-umbrella alias of sessions --active (same lazy module).
  roster: [loadSessions],
  teams: [loadTeams],
  tickets: [loadTickets],
  cloud: [loadCloud],
  message: [loadMessage],
  send: [loadSend],
  notify: [loadSend],
  feed: [loadFeed],
  // Observe-umbrella aliases of feed / feed --filter updates.
  inbox: [loadFeed],
  timeline: [loadFeed],
  mailboxes: [loadMailboxes],
  mailbox: [loadMailboxes],
  serve: [loadServe],
  artifacts: [loadArtifacts],
  // `unshare` is a top-level convenience alias of `artifacts share delete` (see
  // commands/share.ts) — same module, registered as its own program.command().
  unshare: [loadArtifacts],
  audit: [loadAudit],
  webhooks: [loadWebhooks],
  humans: [loadHumans],
  daemon: [loadDaemon],
  cp: [loadCp],
};

/**
 * Top-level names that {@link COMMAND_LOADERS} does not carry because they are
 * registered inline in src/index.ts — closures over entry-point state (the
 * deprecated aliases and tombstones) plus the internal command. They are
 * real commands, so anything that asks "does this command exist?" must count them.
 */
const INLINE_COMMAND_NAMES = [
  'perms', // deprecated alias -> permissions
  'exec', // deprecated alias -> run
  'jobs', // deprecated alias -> routines
  'cron', // deprecated alias -> routines
  'check', // tombstone -> doctor --check
  'resources', // tombstone -> view --merged
  'hq', // tombstone
  '_internal',
] as const;

/**
 * Every top-level command name the CLI answers to — the loader table plus the
 * inline aliases/tombstones above. This is the "does this command exist?"
 * predicate for code that runs BEFORE commander parses, most importantly the
 * `--host`/`--device` router (lib/hosts/passthrough.ts): without it a typo'd
 * command carrying `--host` reported a flag-support error instead of
 * `unknown command` (RUSH-2022).
 *
 * Commander sub-aliases (`sessions ls`, `teams rm`, …) are deliberately absent —
 * this set is top-level only. `command-registry.test.ts` pins it against the real
 * registered command tree so a new command can never drift out of it.
 */
export const KNOWN_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(COMMAND_LOADERS),
  ...INLINE_COMMAND_NAMES,
]);

/**
 * Former top-level names that must NOT auto-correct (edit-distance 1) into a
 * live command. Without this a pruned surface silently misroutes: the typed
 * name is gone, the spellchecker finds a neighbour, and the CLI runs something
 * the user never asked for instead of saying the command is gone.
 *
 * `set` moved under `agents models`/`agents config` (RUSH-2579); `share` moved
 * under `agents artifacts share` (RUSH-2580).
 */
export const RETIRED_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set(['webhook', 'set', 'share']);


/** Whether `name` is a top-level command this CLI registers. See {@link KNOWN_TOP_LEVEL_COMMANDS}. */
export function isKnownTopLevelCommand(name: string): boolean {
  return KNOWN_TOP_LEVEL_COMMANDS.has(name);
}

/**
 * Register every module in {@link COMMAND_LOADERS} onto one fresh program and
 * return it — the full public command tree, deduped by loader identity so a
 * loader mapped to several names (e.g. `add`/`use`/`list` -> versions) runs once.
 *
 * Off the hot path only: the command-index generator (`scripts/gen-command-index.ts`)
 * and the tests build the tree from this. Startup never calls it — src/index.ts
 * registers just the one requested command via `registerEagerForRequest`. The
 * inline aliases/tombstones ({@link INLINE_COMMAND_NAMES}) are NOT included: they
 * are closures over entry-point state that src/index.ts registers directly.
 */
export async function buildFullCommandTree(): Promise<Command> {
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { version: string };
  const program = configureRootCommand(new Command(), 'agents', packageJson.version);
  const done = new Set<ModuleLoader>();
  for (const loaders of Object.values(COMMAND_LOADERS)) {
    for (const loader of loaders) {
      if (done.has(loader)) continue;
      done.add(loader);
      (await loader())(program);
    }
  }
  return program;
}
