import { split as shlexSplit } from 'shlex';

/**
 * Parses the raw command strings agents pass to Bash tool calls into structured
 * metadata: the executable, category, subcommand, and a display summary. Used by
 * session rendering and the activity-log hook so `agents sessions` and
 * `agents activity` can summarize what actually happened instead of printing a
 * wall of shell.
 */

export type BashCategory =
  | 'vcs'
  | 'build-test'
  | 'install'
  | 'remote'
  | 'http'
  | 'media'
  | 'upscaling'
  | 'metadata'
  | 'probe'
  | 'search'
  | 'shell'
  | 'wait'
  | 'other';

export interface BashToolInfo {
  category: BashCategory;
  signal: 'high' | 'mid' | 'low';
  action: string;
  aliases?: string[];
}

export interface BashCommandInfo {
  tool: string;
  category: BashCategory;
  subcommand: string;
  action: string;
  summary: string;
  signal: 'high' | 'mid' | 'low';
}

const TOOL_REGISTRY: Record<string, BashToolInfo> = {
  // VCS
  git: { category: 'vcs', signal: 'mid', action: 'working in git' },
  gh: { category: 'vcs', signal: 'mid', action: 'using GitHub CLI' },

  // Build / test
  bun: { category: 'build-test', signal: 'mid', action: 'running bun' },
  npm: { category: 'build-test', signal: 'mid', action: 'running npm' },
  pnpm: { category: 'build-test', signal: 'mid', action: 'running pnpm' },
  yarn: { category: 'build-test', signal: 'mid', action: 'running yarn' },
  vitest: { category: 'build-test', signal: 'mid', action: 'running vitest' },
  jest: { category: 'build-test', signal: 'mid', action: 'running jest' },
  mocha: { category: 'build-test', signal: 'mid', action: 'running mocha' },
  pytest: { category: 'build-test', signal: 'mid', action: 'running pytest' },
  cargo: { category: 'build-test', signal: 'mid', action: 'running cargo' },
  go: { category: 'build-test', signal: 'mid', action: 'running go' },
  tsc: { category: 'build-test', signal: 'mid', action: 'running tsc' },
  tsx: { category: 'build-test', signal: 'mid', action: 'running tsx' },
  node: { category: 'build-test', signal: 'low', action: 'running node' },
  python: { category: 'build-test', signal: 'low', action: 'running python', aliases: ['python3'] },
  make: { category: 'build-test', signal: 'mid', action: 'running make' },

  // Install
  brew: { category: 'install', signal: 'mid', action: 'installing with brew' },
  pip: { category: 'install', signal: 'mid', action: 'installing with pip', aliases: ['pip3'] },
  apt: { category: 'install', signal: 'mid', action: 'installing with apt' },
  apk: { category: 'install', signal: 'mid', action: 'installing with apk' },

  // Remote
  ssh: { category: 'remote', signal: 'mid', action: 'using ssh' },
  scp: { category: 'remote', signal: 'mid', action: 'using scp' },
  rsync: { category: 'remote', signal: 'mid', action: 'using rsync' },

  // HTTP
  curl: { category: 'http', signal: 'mid', action: 'fetching with curl' },
  wget: { category: 'http', signal: 'mid', action: 'fetching with wget' },

  // Media
  ffmpeg: { category: 'media', signal: 'high', action: 'using ffmpeg' },
  ffprobe: { category: 'media', signal: 'mid', action: 'probing media' },
  magick: { category: 'media', signal: 'mid', action: 'using ImageMagick' },
  convert: { category: 'media', signal: 'mid', action: 'converting images' },
  composite: { category: 'media', signal: 'mid', action: 'compositing images' },
  montage: { category: 'media', signal: 'mid', action: 'montaging images' },
  identify: { category: 'media', signal: 'mid', action: 'identifying images' },

  // Upscaling
  realesrgan: {
    category: 'upscaling',
    signal: 'high',
    action: 'upscaling with realesrgan',
    aliases: ['realesrgan-ncnn-vulkan'],
  },
  waifu2x: {
    category: 'upscaling',
    signal: 'high',
    action: 'upscaling with waifu2x',
    aliases: ['waifu2x-caffe', 'waifu2x-converter-cpp'],
  },
  swin2sr: { category: 'upscaling', signal: 'high', action: 'upscaling with swin2sr' },
  resdet: { category: 'upscaling', signal: 'mid', action: 'detecting upscale' },

  // Metadata
  id3v2: { category: 'metadata', signal: 'mid', action: 'editing id3 tags' },
  exiftool: { category: 'metadata', signal: 'mid', action: 'editing exif metadata' },
  metaflac: { category: 'metadata', signal: 'mid', action: 'editing flac metadata' },
  vorbiscomment: { category: 'metadata', signal: 'mid', action: 'editing vorbis comments' },

  // Shell
  rm: { category: 'shell', signal: 'low', action: 'removing files' },
  mv: { category: 'shell', signal: 'low', action: 'moving files' },
  cp: { category: 'shell', signal: 'low', action: 'copying files' },
  mkdir: { category: 'shell', signal: 'low', action: 'making directories' },
  touch: { category: 'shell', signal: 'low', action: 'touching files' },
  echo: { category: 'shell', signal: 'low', action: 'echoing' },
  printf: { category: 'shell', signal: 'low', action: 'printing' },
  chmod: { category: 'shell', signal: 'low', action: 'changing permissions' },
  ln: { category: 'shell', signal: 'low', action: 'linking files' },
  awk: { category: 'shell', signal: 'low', action: 'running awk' },
  sed: { category: 'shell', signal: 'low', action: 'running sed' },
  tee: { category: 'shell', signal: 'low', action: 'teeing output' },
  xargs: { category: 'shell', signal: 'low', action: 'running xargs' },

  // Probes
  ls: { category: 'probe', signal: 'low', action: 'listing files' },
  cat: { category: 'probe', signal: 'low', action: 'reading files' },
  head: { category: 'probe', signal: 'low', action: 'reading files' },
  tail: { category: 'probe', signal: 'low', action: 'reading files' },
  wc: { category: 'probe', signal: 'low', action: 'counting' },
  stat: { category: 'probe', signal: 'low', action: 'statting files' },
  file: { category: 'probe', signal: 'low', action: 'inspecting files' },
  which: { category: 'probe', signal: 'low', action: 'locating binaries' },
  tree: { category: 'probe', signal: 'low', action: 'listing files' },
  pwd: { category: 'probe', signal: 'low', action: 'printing pwd' },

  // Search
  grep: { category: 'search', signal: 'low', action: 'searching' },
  rg: { category: 'search', signal: 'low', action: 'searching with ripgrep' },
  ag: { category: 'search', signal: 'low', action: 'searching with the silver searcher' },
  fd: { category: 'search', signal: 'low', action: 'searching files' },
  find: { category: 'search', signal: 'low', action: 'finding files' },

  // Wait
  sleep: { category: 'wait', signal: 'low', action: 'sleeping' },
  wait: { category: 'wait', signal: 'low', action: 'waiting' },
};

/** Tools whose bucket key should include the second token (subcommand). */
const TWO_LEVEL_TOOLS = new Set(['git', 'gh', 'bun', 'npm', 'cargo', 'docker', 'kubectl', 'rush', 'openclaw', 'pnpm', 'yarn']);

/**
 * Flags on a two-level tool that consume the *following* token as their value, so
 * the subcommand scan must skip both. Missing one here mis-reads the value as the
 * subcommand (e.g. `gh -R owner/repo pr create` → subcommand `owner/repo`).
 */
const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '-R', '--repo', '--cwd']);

/** Remote wrappers whose bucket key carries an `ssh→` prefix on the inner command. */
const REMOTE_WRAPPERS = new Set(['ssh', 'scp', 'rsync']);

const ALIAS_MAP: Map<string, string> = new Map();
for (const [name, info] of Object.entries(TOOL_REGISTRY)) {
  ALIAS_MAP.set(name, name);
  for (const alias of info.aliases ?? []) {
    ALIAS_MAP.set(alias, name);
  }
}

export function unwrapCommand(cmd: string): string {
  const s = cmd.trim();
  // ssh host command
  const ssh = s.match(/^ssh\s+\S+\s+["']?(.+?)["']?\s*(?:\|.*)?$/);
  if (ssh) return unwrapCommand(ssh[1]);
  // VAR=value prefix (value may be a single- or double-quoted string with spaces)
  const env = s.match(/^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+(.+)$/);
  if (env) return unwrapCommand(env[2]);
  // sudo / time prefix (value-taking flags like `-u user` consume their argument)
  const prefix = s.match(/^(?:sudo|time)(?:\s+(?:-[uUgGhpCrtDR]\s+\S+|-\S+))*\s+(.+)$/);
  if (prefix) return unwrapCommand(prefix[1]);
  // cd foo && command
  const cd = s.match(/^cd\s+\S+\s*&&\s*(.+)$/);
  if (cd) return unwrapCommand(cd[1]);
  // npx / bunx
  const npx = s.match(/^(?:npx|bunx)\s+(?:-\S+\s+)*(.+)$/);
  if (npx) return unwrapCommand(npx[1]);
  return s;
}

function splitOnOperators(cmd: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (escaped) {
      current += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      i += 1;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      i += 1;
      continue;
    }
    if (cmd.slice(i, i + 2) === '&&' || cmd.slice(i, i + 2) === '||') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += 2;
      continue;
    }
    if (ch === '|' || ch === ';') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Split a possibly-compound Bash command into simple commands, then tokenize each
 * with shlex. Returns an empty array for empty input.
 */
export function tokenizeBash(cmd: string): string[][] {
  const unwrapped = unwrapCommand(cmd);
  const segments = splitOnOperators(unwrapped);
  const out: string[][] = [];
  for (const seg of segments) {
    try {
      const tokens = shlexSplit(seg);
      if (tokens.length) out.push(tokens);
    } catch {
      // If shlex can't parse, fall back to whitespace split.
      const tokens = seg.split(/\s+/).filter(Boolean);
      if (tokens.length) out.push(tokens);
    }
  }
  return out;
}

/**
 * First non-flag token after the executable — its subcommand. Skips leading
 * flags, and skips the argument of a value-taking flag (see VALUE_FLAGS) so e.g.
 * `git -C /repo commit` resolves to `commit`, not `-C`/`/repo`.
 */
function scanSubcommand(tokens: string[]): string {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      i += VALUE_FLAGS.has(t) ? 2 : 1;
      continue;
    }
    return t.toLowerCase();
  }
  return '';
}

/**
 * Classify the first simple command in a Bash string. Returns coarse metadata
 * (tool name, category, subcommand, human action) used for summaries and
 * activity logging. Unknown executables fall back to `other`.
 */
export function classifyBashCommand(command: string): BashCommandInfo {
  const simpleCommands = tokenizeBash(command);
  if (!simpleCommands.length) {
    return { tool: 'other', category: 'other', subcommand: '', action: 'running command', summary: '', signal: 'low' };
  }
  const tokens = simpleCommands[0];
  if (!tokens.length) {
    return { tool: 'other', category: 'other', subcommand: '', action: 'running command', summary: '', signal: 'low' };
  }

  const first = tokens[0];
  const baseRaw = first.replace(/^[./]+/, '').toLowerCase();
  const base = baseRaw.endsWith('.exe') ? baseRaw.slice(0, -4) : baseRaw;
  const canonical = ALIAS_MAP.get(base);
  const info = canonical ? TOOL_REGISTRY[canonical] : undefined;

  if (!info) {
    // Unknown executable. A known two-level tool that isn't in the registry
    // (docker/kubectl/rush/openclaw) still surfaces its subcommand so bucketing
    // stays useful; the category stays honestly 'other'.
    const subcommand = TWO_LEVEL_TOOLS.has(base) ? scanSubcommand(tokens) : '';
    const summary = subcommand ? `${base} ${subcommand}` : base;
    return { tool: base, category: 'other', subcommand, action: 'running command', summary, signal: 'low' };
  }

  const subcommand = canonical && TWO_LEVEL_TOOLS.has(canonical) ? scanSubcommand(tokens) : '';

  const safeCanonical = canonical || base;
  const summary = subcommand ? `${safeCanonical} ${subcommand}` : safeCanonical;
  return {
    tool: safeCanonical,
    category: info.category,
    subcommand,
    action: info.action,
    summary,
    signal: info.signal,
  };
}

/**
 * Stable bucket key for grouping similar Bash commands in summaries. Commands run
 * through a remote wrapper (ssh/scp/rsync) get an `ssh→` prefix on the inner key,
 * so `ssh host "git push"` buckets as `ssh→git push`, distinct from a local push.
 */
export function bucketKey(command: string): string {
  const info = classifyBashCommand(command);
  const base = !info.tool
    ? 'other'
    : info.subcommand && TWO_LEVEL_TOOLS.has(info.tool)
      ? `${info.tool} ${info.subcommand}`
      : info.tool;
  const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return REMOTE_WRAPPERS.has(first) ? `ssh→${base}` : base;
}

/**
 * Detect high-signal Bash-driven milestones (video renders, upscales, metadata
 * edits, git commits/pushes/worktrees, PR opens). Returns null for routine
 * commands.
 */
export function detectBashMilestone(command: string): { event: string; detail: string } | null {
  const info = classifyBashCommand(command);
  const lower = (command || '').toLowerCase();

  if (info.category === 'upscaling') {
    return { event: 'image.upscaled', detail: info.action };
  }

  if (info.tool === 'ffmpeg') {
    const hasOutput = /\s+\S+\.\w{2,5}\s*$/.test(command || '');
    if (hasOutput || lower.includes('-c:v') || lower.includes('-codec') || lower.includes('libx264')) {
      return { event: 'video.rendered', detail: 'ffmpeg render' };
    }
    return { event: 'video.converted', detail: 'ffmpeg' };
  }

  if (info.category === 'metadata') {
    return { event: 'metadata.edited', detail: info.action };
  }

  if (info.tool === 'git') {
    if (info.subcommand === 'commit') return { event: 'commit.created', detail: 'git commit' };
    if (info.subcommand === 'push') return { event: 'pushed', detail: 'git push' };
    if (info.subcommand === 'worktree') {
      if (lower.includes('worktree add')) return { event: 'worktree.created', detail: 'git worktree add' };
      if (lower.includes('worktree remove')) return { event: 'worktree.removed', detail: 'git worktree remove' };
    }
  }

  if (info.tool === 'gh' && info.subcommand === 'pr') {
    if (lower.includes('pr create')) return { event: 'pr.opened', detail: 'gh pr create' };
    if (lower.includes('pr merge')) return { event: 'pr.merged', detail: 'gh pr merge' };
  }

  return null;
}

/**
 * Human-readable category label for renderers.
 */
export function categoryLabel(category: BashCategory): string {
  switch (category) {
    case 'vcs': return 'Version control';
    case 'build-test': return 'Build / test';
    case 'install': return 'Install';
    case 'remote': return 'Remote';
    case 'http': return 'HTTP';
    case 'media': return 'Media';
    case 'upscaling': return 'Upscaling';
    case 'metadata': return 'Metadata';
    case 'probe': return 'Probes';
    case 'search': return 'Search';
    case 'shell': return 'Shell';
    case 'wait': return 'Wait';
    default: return 'Other';
  }
}
