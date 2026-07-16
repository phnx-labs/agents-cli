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
import type { Command } from 'commander';

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
export const loadWorktree: ModuleLoader = async () => (await import('../../commands/worktree.js')).registerWorktreeCommands;
export const loadVersions: ModuleLoader = async () => (await import('../../commands/versions.js')).registerVersionsCommands;
export const loadImport: ModuleLoader = async () => (await import('../../commands/import.js')).registerImportCommand;
export const loadPackages: ModuleLoader = async () => (await import('../../commands/packages.js')).registerPackagesCommands;
export const loadDaemon: ModuleLoader = async () => (await import('../../commands/daemon.js')).registerDaemonCommands;
export const loadRoutines: ModuleLoader = async () => (await import('../../commands/routines.js')).registerRoutinesCommands;
export const loadRun: ModuleLoader = async () => (await import('../../commands/exec.js')).registerRunCommand;
export const loadDefaults: ModuleLoader = async () => (await import('../../commands/defaults.js')).registerDefaultsCommands;
export const loadModels: ModuleLoader = async () => (await import('../../commands/models.js')).registerModelsCommand;
export const loadPrune: ModuleLoader = async () => (await import('../../commands/prune.js')).registerPruneCommand;
export const loadTrash: ModuleLoader = async () => (await import('../../commands/trash.js')).registerTrashCommands;
export const loadRestore: ModuleLoader = async () => (await import('../../commands/trash.js')).registerRestoreCommand;
export const loadDoctor: ModuleLoader = async () => (await import('../../commands/doctor.js')).registerDoctorCommand;
export const loadApply: ModuleLoader = async () => (await import('../../commands/apply.js')).registerApplyCommand;
export const loadCheck: ModuleLoader = async () => (await import('../../commands/check.js')).registerCheckCommand;
export const loadStatus: ModuleLoader = async () => (await import('../../commands/status.js')).registerStatusCommand;
export const loadProfiles: ModuleLoader = async () => (await import('../../commands/profiles.js')).registerProfilesCommands;
export const loadSecrets: ModuleLoader = async () => (await import('../../commands/secrets.js')).registerSecretsCommands;
export const loadWallet: ModuleLoader = async () => (await import('../../commands/wallet.js')).registerWalletCommands;
export const loadHelper: ModuleLoader = async () => (await import('../../commands/helper.js')).registerHelperCommand;
export const loadMenubar: ModuleLoader = async () => (await import('../../commands/menubar.js')).registerMenubarCommands;
export const loadBeta: ModuleLoader = async () => (await import('../../commands/beta.js')).registerBetaCommands;
export const loadSync: ModuleLoader = async () => (await import('../../commands/sync.js')).registerSyncCommand;
export const loadLock: ModuleLoader = async () => (await import('../../commands/lock.js')).registerLockCommand;
export const loadRefreshRules: ModuleLoader = async () => (await import('../../commands/refresh-rules.js')).registerRefreshRulesCommand;
export const loadDrive: ModuleLoader = async () => (await import('../../commands/drive.js')).registerDriveCommands;
export const loadFactory: ModuleLoader = async () => (await import('../../commands/factory.js')).registerFactoryCommands;
export const loadUsage: ModuleLoader = async () => (await import('../../commands/usage.js')).registerUsageCommand;
export const loadCost: ModuleLoader = async () => (await import('../../commands/cost.js')).registerCostCommand;
export const loadOutput: ModuleLoader = async () => (await import('../../commands/output.js')).registerOutputCommand;
export const loadBudget: ModuleLoader = async () => (await import('../../commands/budget.js')).registerBudgetCommand;
export const loadAlias: ModuleLoader = async () => (await import('../../commands/alias.js')).registerAliasCommand;
export const loadPty: ModuleLoader = async () => (await import('../../commands/pty.js')).registerPtyCommands;
export const loadTmux: ModuleLoader = async () => (await import('../../commands/tmux.js')).registerTmuxCommands;
export const loadWatchdog: ModuleLoader = async () => (await import('../../commands/watchdog.js')).registerWatchdogCommand;
export const loadBrowser: ModuleLoader = async () => (await import('../../commands/browser.js')).registerBrowserCommand;
export const loadComputer: ModuleLoader = async () => (await import('../../commands/computer.js')).registerComputerCommand;
export const loadHosts: ModuleLoader = async () => (await import('../../commands/hosts.js')).registerHostsCommand;
export const loadLease: ModuleLoader = async () => (await import('../../commands/lease.js')).registerLeaseCommand;
export const loadLogs: ModuleLoader = async () => (await import('../../commands/logs.js')).registerLogsCommand;
export const loadEvents: ModuleLoader = async () => (await import('../../commands/events.js')).registerEventsCommand;
export const loadSsh: ModuleLoader = async () => (await import('../../commands/ssh.js')).registerSshCommands;
export const loadPull: ModuleLoader = async () => (await import('../../commands/pull.js')).registerPullCommand;
export const loadPush: ModuleLoader = async () => (await import('../../commands/push.js')).registerPushCommand;
export const loadRepo: ModuleLoader = async () => (await import('../../commands/repo.js')).registerRepoCommands;
export const loadSetup: ModuleLoader = async () => (await import('../../commands/setup.js')).registerSetupCommand;
export const loadSessions: ModuleLoader = async () => (await import('../../commands/sessions.js')).registerSessionsCommands;
export const loadTeams: ModuleLoader = async () => (await import('../../commands/teams.js')).registerTeamsCommands;
export const loadCloud: ModuleLoader = async () => (await import('../../commands/cloud.js')).registerCloudCommands;
export const loadMessage: ModuleLoader = async () => (await import('../../commands/message.js')).registerMessageCommand;
export const loadFeed: ModuleLoader = async () => (await import('../../commands/feed.js')).registerFeedCommand;
export const loadMailboxes: ModuleLoader = async () => (await import('../../commands/mailboxes.js')).registerMailboxesCommand;
export const loadServe: ModuleLoader = async () => (await import('../../commands/serve.js')).registerServeCommand;
export const loadAudit: ModuleLoader = async () => (await import('../../commands/audit.js')).registerAuditCommands;
export const loadWebhook: ModuleLoader = async () => (await import('../../commands/webhook.js')).registerWebhookCommand;
export const loadFunnel: ModuleLoader = async () => (await import('../../commands/funnel.js')).registerFunnelCommand;

/**
 * Commands whose modules pull in the SQLite-backed session/cloud stack. They are
 * registered AFTER `applyGlobalHelpConventions` (mirroring main's order: help
 * conventions at module top-level, lazy registration just before parse), so they
 * inherit the root's custom help formatter rather than getting the per-command
 * recursive pass. Keeping that ordering preserves their `--help` output exactly.
 */
export const LAZY_COMMAND_NAMES: ReadonlySet<string> = new Set(['sessions', 'teams', 'cloud', 'message', 'serve']);

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
  cli: [loadCli],
  subagents: [loadSubagents],
  plugins: [loadPlugins],
  workflows: [loadWorkflows],
  worktree: [loadWorktree],
  add: [loadVersions],
  use: [loadVersions],
  list: [loadVersions],
  remove: [loadVersions],
  rm: [loadVersions],
  purge: [loadVersions],
  prune: [loadVersions, loadPrune],
  import: [loadImport],
  registry: [loadPackages],
  search: [loadPackages],
  install: [loadPackages],
  daemon: [loadDaemon],
  routines: [loadRoutines],
  run: [loadRun],
  defaults: [loadDefaults],
  models: [loadModels],
  trash: [loadTrash],
  restore: [loadRestore],
  doctor: [loadDoctor],
  apply: [loadApply],
  check: [loadCheck],
  status: [loadStatus],
  profiles: [loadProfiles],
  secrets: [loadSecrets],
  wallet: [loadWallet],
  helper: [loadHelper],
  menubar: [loadMenubar],
  beta: [loadBeta],
  sync: [loadSync],
  lock: [loadLock],
  'refresh-rules': [loadRefreshRules],
  drive: [loadDrive],
  factory: [loadFactory],
  usage: [loadUsage],
  cost: [loadCost],
  output: [loadOutput],
  budget: [loadBudget],
  alias: [loadAlias],
  pty: [loadPty],
  tmux: [loadTmux],
  watchdog: [loadWatchdog],
  browser: [loadBrowser],
  computer: [loadComputer],
  hosts: [loadHosts],
  lease: [loadLease],
  logs: [loadLogs],
  events: [loadEvents],
  ssh: [loadSsh],
  devices: [loadSsh],
  // `fleet` is a commander alias of `devices` (see commands/ssh.ts); list it so
  // lazy registration loads the devices tree when the user types `agents fleet`.
  fleet: [loadSsh],
  pull: [loadPull],
  push: [loadPush],
  // `repos` is the canonical command name; `repo` remains a convenience alias
  // (see commands/repo.ts). List both so lazy registration loads the tree
  // whichever the user types.
  repos: [loadRepo],
  repo: [loadRepo],
  setup: [loadSetup],
  sessions: [loadSessions],
  teams: [loadTeams],
  cloud: [loadCloud],
  message: [loadMessage],
  feed: [loadFeed],
  mailboxes: [loadMailboxes],
  mailbox: [loadMailboxes],
  serve: [loadServe],
  audit: [loadAudit],
  webhook: [loadWebhook],
  funnel: [loadFunnel],
};
