const LOADED_COMMAND_NAMES = [
  'accounts', 'view', 'inspect', 'feedback', 'commands', 'hooks', 'skills', 'rules', 'memory',
  'permissions', 'mcp', 'clis', 'subagents', 'plugins', 'workflows', 'add', 'use', 'list',
  'remove', 'rm', 'purge', 'update', 'prune', 'import', 'registry', 'search', 'install',
  'routines', 'monitors', 'projects', 'run', 'resume', 'open', 'reconnect', 'fork', 'config',
  'models', 'modes', 'trash', 'restore', 'doctor', 'apply', 'status', 'snapshot', 'profiles',
  'route', 'harness', 'harnesses', 'secrets', 'login', 'logout', 'menubar', 'beta', 'sync',
  'refresh-rules', 'factory', 'usage', 'cost', 'insights', 'perf', 'bench', 'trends', 'output',
  'budget', 'alias', 'mine', 'pty', 'tmux', 'watchdog', 'browser', 'computer', 'logs', 'events',
  'ssh', 'devices', 'fleet', 'repos', 'repo', 'setup', 'uninstall', 'upgrade', 'sessions',
  'roster', 'teams', 'tickets', 'cloud', 'message', 'send', 'notify', 'feed', 'inbox',
  'timeline', 'mailboxes', 'mailbox', 'serve', 'artifacts', 'unshare', 'audit', 'webhooks',
  'humans', 'daemon', 'cp',
] as const;

const INLINE_COMMAND_NAMES = [
  'perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', '_internal',
] as const;

export const KNOWN_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set<string>([
  ...LOADED_COMMAND_NAMES,
  ...INLINE_COMMAND_NAMES,
]);

export const RETIRED_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set(['webhook', 'set', 'share']);

export function isKnownTopLevelCommand(name: string): boolean {
  return KNOWN_TOP_LEVEL_COMMANDS.has(name);
}
