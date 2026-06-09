/**
 * One-shot idempotent migrations for the FOUNDATION refactor.
 *
 * Called from postinstall and as a command-time fallback from agents view/use/pull.
 * Each migration is guarded by an existence check so re-running is safe.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';

const HOME = process.env.HOME ?? os.homedir();
const USER_DIR = path.join(HOME, '.agents');
/** Canonical system-repo location (post-fold). */
const SYSTEM_DIR = path.join(USER_DIR, '.system');
/** Legacy system-repo location — folded into SYSTEM_DIR by foldLegacySystemRepo(). */
const LEGACY_SYSTEM_DIR = path.join(HOME, '.agents-system');
const HISTORY_DIR = path.join(USER_DIR, '.history');
const CACHE_DIR = path.join(USER_DIR, '.cache');

/**
 * Fold ~/.agents-system/ into ~/.agents/.system/.
 *
 * MUST run first in runMigration() — every other migrator reads SYSTEM_DIR
 * (the new path), so the contents have to be there before they execute.
 *
 * Strategy:
 *   1. If legacy dir doesn't exist or is already a symlink, no-op.
 *   2. If new path doesn't exist yet, rename in one shot (fast path).
 *   3. If both exist (mid-migration / re-run on partially-migrated state),
 *      merge legacy → new with new winning on collision, then drop legacy.
 *
 * After the contents move, the legacy path becomes a symlink → SYSTEM_DIR
 * so external tooling that still references ~/.agents-system/ keeps
 * resolving correctly. The symlink is harmless on its own and can be
 * removed with `rm ~/.agents-system` once everything has updated.
 *
 * Idempotent: re-running converges to "contents at SYSTEM_DIR, symlink at
 * LEGACY_SYSTEM_DIR" without duplicating data.
 */
export function foldLegacySystemRepo(): void {
  let legacyStat: fs.Stats | null = null;
  try { legacyStat = fs.lstatSync(LEGACY_SYSTEM_DIR); } catch { /* missing */ }
  if (!legacyStat) return;
  if (legacyStat.isSymbolicLink()) return;
  if (!legacyStat.isDirectory()) return;

  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  } catch { /* best-effort */ }

  if (!fs.existsSync(SYSTEM_DIR)) {
    try {
      fs.renameSync(LEGACY_SYSTEM_DIR, SYSTEM_DIR);
      try { fs.symlinkSync(SYSTEM_DIR, LEGACY_SYSTEM_DIR); } catch { /* best-effort */ }
      console.error('Folded ~/.agents-system/ into ~/.agents/.system/ (left back-compat symlink)');
      return;
    } catch {
      // Cross-device rename or perm issue — fall through to copy + remove.
    }
  }

  try {
    copyDirSkipExisting(LEGACY_SYSTEM_DIR, SYSTEM_DIR);
    fs.rmSync(LEGACY_SYSTEM_DIR, { recursive: true, force: true });
    try { fs.symlinkSync(SYSTEM_DIR, LEGACY_SYSTEM_DIR); } catch { /* best-effort */ }
    console.error('Merged ~/.agents-system/ into ~/.agents/.system/ (left back-compat symlink)');
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/agents.yaml -> ~/.agents/agents.yaml.
 * No-op if user file already exists or system file absent.
 * (This is also handled inline in state.ts readMeta, but is exposed here
 *  for explicit migration calls from postinstall / CLI entry points.)
 */
function migrateAgentsYaml(): void {
  const src = path.join(SYSTEM_DIR, 'agents.yaml');
  const dest = path.join(USER_DIR, 'agents.yaml');
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    // User copy is authoritative — drop the stale system leftover. The system
    // repo (npm-shipped) does not track agents.yaml; any copy here is residue
    // from the pre-split layout.
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    return;
  }
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
    console.error('Migrated agents.yaml to ~/.agents/');
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents-system/prompts.json (dead file — zero refs in src/).
 */
function deleteSystemPromptsJson(): void {
  const f = path.join(SYSTEM_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/config.json -> ~/.agents/teams/config.json.
 * The teams persistence layer already reads the legacy path as a fallback;
 * moving it here keeps the canonical location consistent.
 */
// Delete the legacy ~/.agents-system/config.json. This was the teams agent
// registry, which no longer exists — `agents teams` discovers agents through
// `listInstalledVersions` and invokes them through `agents run`.
function migrateSystemConfigJson(): void {
  const src = path.join(SYSTEM_DIR, 'config.json');
  if (!fs.existsSync(src)) return;
  try {
    fs.unlinkSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move promptcuts.yaml from each repo root into hooks/ subdir.
 *   ~/.agents-system/promptcuts.yaml -> ~/.agents-system/hooks/promptcuts.yaml
 *   ~/.agents/promptcuts.yaml        -> ~/.agents/hooks/promptcuts.yaml
 * Idempotent: skips if dest already exists or src absent.
 */
function migratePromptcutsIntoHooks(): void {
  for (const root of [SYSTEM_DIR, USER_DIR]) {
    const src = path.join(root, 'promptcuts.yaml');
    const dest = path.join(root, 'hooks', 'promptcuts.yaml');
    if (fs.existsSync(dest) || !fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
    } catch { /* best-effort */ }
  }
}

/**
 * Move installed agent versions from the legacy system-root layout
 * (~/.agents-system/versions/<agent>/<ver>/) into the user root
 * (~/.agents/versions/<agent>/<ver>/).
 *
 * Earlier installs (and an inverted prior version of this migrator) put
 * binaries and home dirs under ~/.agents-system/. The current architecture
 * keeps all operational state (versions, sessions, shims, trash) under
 * ~/.agents/, and getVersionsDir() in state.ts resolves there. Without this
 * migration the legacy versions become invisible to listInstalledVersions
 * and every command that depends on it (view, prune, run, sync) writes a
 * second copy to ~/.agents/versions/ while the agent CLIs keep reading the
 * stale ~/.agents-system/versions/ copy via the existing ~/.<agent> symlink.
 *
 * Idempotent and non-destructive: if a same-named dest already exists we
 * leave the legacy copy in place so the user can reconcile manually.
 */
function migrateSystemVersionsToUser(): void {
  const sysVersions = path.join(SYSTEM_DIR, 'versions');
  const userVersions = path.join(USER_DIR, 'versions');
  if (!fs.existsSync(sysVersions)) return;

  let movedCount = 0;
  let skippedCount = 0;

  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(sysVersions, { withFileTypes: true });
  } catch {
    return;
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue;
    const srcAgentDir = path.join(sysVersions, agent.name);
    const dstAgentDir = path.join(userVersions, agent.name);
    try {
      fs.mkdirSync(dstAgentDir, { recursive: true, mode: 0o700 });
    } catch { /* best-effort */ }

    let verEntries: fs.Dirent[];
    try {
      verEntries = fs.readdirSync(srcAgentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ver of verEntries) {
      if (!ver.isDirectory()) continue;
      const src = path.join(srcAgentDir, ver.name);
      const dst = path.join(dstAgentDir, ver.name);
      if (fs.existsSync(dst)) {
        skippedCount++;
        continue;
      }
      try {
        fs.renameSync(src, dst);
        movedCount++;
      } catch { /* best-effort, leave legacy in place */ }
    }
    try {
      if (fs.readdirSync(srcAgentDir).length === 0) fs.rmdirSync(srcAgentDir);
    } catch { /* best-effort */ }
  }

  try {
    if (fs.readdirSync(sysVersions).length === 0) fs.rmdirSync(sysVersions);
  } catch { /* best-effort */ }

  if (movedCount > 0) {
    console.error(`Migrated ${movedCount} version dir${movedCount === 1 ? '' : 's'} from ~/.agents-system/versions/ to ~/.agents/versions/`);
  }
  if (skippedCount > 0) {
    console.error(`Skipped ${skippedCount} version dir${skippedCount === 1 ? '' : 's'} already present in ~/.agents/versions/ (kept legacy copy at ~/.agents-system/versions/)`);
  }
}

/**
 * Move ~/. agents/runs/ -> ~/.agents/routines/runs/.
 * Runs now live inside routines directory for cleaner organization.
 */
function migrateRunsIntoRoutines(): void {
  const src = path.join(USER_DIR, 'runs');
  const dest = path.join(USER_DIR, 'routines', 'runs');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents/trash/ -> ~/.agents/.trash/.
 * Hide the trash directory.
 */
function migrateTrashToHidden(): void {
  const src = path.join(USER_DIR, 'trash');
  const dest = path.join(USER_DIR, '.trash');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents/backups/ -> ~/.agents/.backups/.
 * Hide the backups directory.
 */
function migrateBackupsToHidden(): void {
  const src = path.join(USER_DIR, 'backups');
  const dest = path.join(USER_DIR, '.backups');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/**
 * Fold ~/.agents/hooks.yaml into ~/.agents/agents.yaml under a `hooks:` key,
 * then delete the standalone hooks.yaml. Single user file to sync.
 *
 * On collision (a hook name already exists in agents.yaml hooks:), the
 * existing agents.yaml entry wins and the standalone copy is dropped — this
 * matches the behavior a user would get if they had already migrated
 * manually and edited agents.yaml.
 *
 * Idempotent: skips if hooks.yaml is absent or unparseable.
 */
function foldUserHooksYamlIntoAgentsYaml(): void {
  const hooksFile = path.join(USER_DIR, 'hooks.yaml');
  if (!fs.existsSync(hooksFile)) return;

  let hooks: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(hooksFile, 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown> | null;
    hooks = parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return; }

  const metaFile = path.join(USER_DIR, 'agents.yaml');
  let meta: Record<string, unknown> = {};
  if (fs.existsSync(metaFile)) {
    try {
      const raw = fs.readFileSync(metaFile, 'utf-8');
      const parsed = yaml.parse(raw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch { return; }
  }

  const existingHooks = (meta.hooks as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = { ...hooks, ...existingHooks };
  meta.hooks = merged;

  const header = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agents-cli

`;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(metaFile, header + yaml.stringify(meta), 'utf-8');
    fs.unlinkSync(hooksFile);
    console.error('Folded ~/.agents/hooks.yaml into ~/.agents/agents.yaml (hooks: section)');
  } catch { /* best-effort */ }
}

/**
 * Fold ~/.agents/browser/profiles/*.yaml into ~/.agents/agents.yaml under a
 * `browser:` key, then delete the profiles directory. Single user file to sync.
 *
 * On collision (a profile name already exists in agents.yaml browser:), the
 * existing agents.yaml entry wins and the standalone copy is dropped.
 *
 * Idempotent: skips if profiles dir is absent or empty.
 */
function foldBrowserProfilesIntoAgentsYaml(): void {
  const profilesDir = path.join(USER_DIR, 'browser', 'profiles');
  if (!fs.existsSync(profilesDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.yaml'));
  } catch { return; }
  if (files.length === 0) return;

  const profiles: Record<string, unknown> = {};
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(profilesDir, file), 'utf-8');
      const parsed = yaml.parse(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') continue;
      const name = (parsed.name as string) || file.replace(/\.yaml$/, '');
      const { name: _, ...config } = parsed;
      profiles[name] = config;
    } catch { /* skip unreadable file */ }
  }

  if (Object.keys(profiles).length === 0) return;

  const metaFile = path.join(USER_DIR, 'agents.yaml');
  let meta: Record<string, unknown> = {};
  if (fs.existsSync(metaFile)) {
    try {
      const raw = fs.readFileSync(metaFile, 'utf-8');
      const parsed = yaml.parse(raw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch { return; }
  }

  const existingBrowser = (meta.browser as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = { ...profiles, ...existingBrowser };
  meta.browser = merged;

  const header = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agents-cli

`;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(metaFile, header + yaml.stringify(meta), 'utf-8');
    for (const file of files) {
      try { fs.unlinkSync(path.join(profilesDir, file)); } catch { /* best-effort */ }
    }
    try { fs.rmdirSync(profilesDir); } catch { /* may not be empty */ }
    try {
      const browserDir = path.join(USER_DIR, 'browser');
      if (fs.existsSync(browserDir) && fs.readdirSync(browserDir).length === 0) {
        fs.rmdirSync(browserDir);
      }
    } catch { /* best-effort */ }
    console.error('Folded ~/.agents/browser/profiles/ into ~/.agents/agents.yaml (browser: section)');
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents/linear.json. The linear-cli now manages its own
 * credentials in the OS keychain; this file was a legacy plaintext store.
 */
function deleteUserLinearJson(): void {
  const f = path.join(USER_DIR, 'linear.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents/prompts.json. Dead file with zero refs in src/ (the
 * system-repo copy was cleared by deleteSystemPromptsJson; this is the
 * matching cleanup at the user layer).
 */
function deleteUserPromptsJson(): void {
  const f = path.join(USER_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Delete ~/.agents/teams/config.json. The teams subsystem no longer carries
 * its own agent registry — agent discovery flows through `listInstalledVersions`
 * (the same source `agents view` uses) and invocation flows through
 * `agents run`. The on-disk file is pure dead state on existing installs.
 */
function deleteTeamsConfigJson(): void {
  const f = path.join(USER_DIR, 'teams', 'config.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents/teams/registry.json → ~/.agents/.history/teams/registry.json.
 * The registry is per-machine runtime state (timestamps + absolute worktree
 * paths) and belongs in the durable-runtime bucket, not at the user-root
 * where `agents repo push` would sync it across machines.
 */
function moveTeamsRegistryToHistory(): void {
  const src = path.join(USER_DIR, 'teams', 'registry.json');
  const dest = path.join(HISTORY_DIR, 'teams', 'registry.json');
  moveFileOnce(src, dest);
}

/**
 * Delete ~/.agents/config.json. This was the legacy teams config location;
 * the teams subsystem no longer carries a config file at all, so the legacy
 * copy is simply removed.
 */
function cleanupUserConfigJson(): void {
  const legacy = path.join(USER_DIR, 'config.json');
  if (!fs.existsSync(legacy)) return;
  try {
    fs.unlinkSync(legacy);
  } catch { /* best-effort */ }
}

/**
 * Remove an empty ~/.agents/runs/ directory left over after the
 * migrateRunsIntoRoutines() rename. Some older code paths re-created the
 * empty parent; this trims it once it has no contents.
 */
function cleanupEmptyTopLevelRuns(): void {
  const dir = path.join(USER_DIR, 'runs');
  if (!fs.existsSync(dir)) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/aliases.json -> ~/.agents/aliases.json.
 * Aliases are per-user state and were previously written to the system root
 * by mistake. Idempotent: skips if dest already exists or src absent.
 */
function migrateAliasesToUser(): void {
  const src = path.join(SYSTEM_DIR, 'aliases.json');
  const dest = path.join(USER_DIR, 'aliases.json');
  if (fs.existsSync(dest) || !fs.existsSync(src)) return;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/**
 * For overlapping versions that exist in BOTH ~/.agents-system/versions/ and
 * ~/.agents/versions/, merge legacy operational state (history, sessions,
 * settings) into the user copy without overwriting any files synced by
 * agents-cli (skills, commands, hooks, memory). Then drop the legacy copy.
 *
 * Why: when both paths exist, the inverted-prior migrator left them split.
 * Agent CLIs read from ~/.<agent> (a symlink that historically targeted
 * the system path), while sync writes to the user path. Same skill ends up
 * in both → duplicate entries in the skills picker, stale state, broken
 * resource resolution.
 *
 * Strategy: copy legacy → user with "skip if exists". Sync-managed dirs
 * (which live in user already, freshly written) stay untouched. Anything
 * the agent CLI created on its own (history.jsonl, sessions/, settings.json,
 * file-history/, paste-cache/, …) lands in user where it belongs. The
 * legacy version-home is then renamed into ~/.agents/.trash/versions/ so
 * it's recoverable.
 */
function mergeOverlappingVersionHomes(): void {
  const sysVersions = path.join(SYSTEM_DIR, 'versions');
  const userVersions = path.join(USER_DIR, 'versions');
  if (!fs.existsSync(sysVersions)) return;

  let mergedCount = 0;
  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(sysVersions, { withFileTypes: true });
  } catch {
    return;
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue;
    const sysAgentDir = path.join(sysVersions, agent.name);
    const userAgentDir = path.join(userVersions, agent.name);
    let verEntries: fs.Dirent[];
    try {
      verEntries = fs.readdirSync(sysAgentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ver of verEntries) {
      if (!ver.isDirectory()) continue;
      const sysHome = path.join(sysAgentDir, ver.name, 'home');
      const userHome = path.join(userAgentDir, ver.name, 'home');
      if (!fs.existsSync(sysHome) || !fs.existsSync(userHome)) continue;

      try {
        copyDirSkipExisting(sysHome, userHome);

        const trashRoot = path.join(USER_DIR, '.trash', 'versions', agent.name, ver.name);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(sysAgentDir, ver.name), path.join(trashRoot, `legacy-${stamp}`));
        mergedCount++;
      } catch { /* best-effort */ }
    }
    try {
      if (fs.readdirSync(sysAgentDir).length === 0) fs.rmdirSync(sysAgentDir);
    } catch { /* best-effort */ }
  }
  try {
    if (fs.readdirSync(sysVersions).length === 0) fs.rmdirSync(sysVersions);
  } catch { /* best-effort */ }

  if (mergedCount > 0) {
    console.error(`Merged ${mergedCount} overlapping version home${mergedCount === 1 ? '' : 's'} from legacy ~/.agents-system/versions/ into ~/.agents/versions/ (legacy moved to ~/.agents/.trash/versions/)`);
  }
}

function copyDirSkipExisting(src: string, dest: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (fs.existsSync(d)) {
      if (entry.isDirectory()) {
        const dStat = fs.lstatSync(d);
        if (dStat.isDirectory()) copyDirSkipExisting(s, d);
      }
      continue;
    }
    try {
      fs.renameSync(s, d);
    } catch {
      try {
        if (entry.isDirectory()) {
          copyDirSkipExisting(s, d);
        } else if (entry.isSymbolicLink()) {
          fs.symlinkSync(fs.readlinkSync(s), d);
        } else {
          fs.copyFileSync(s, d);
        }
      } catch { /* best-effort */ }
    }
  }
}

/**
 * Rename ~/.agents/permissions/sets/ -> ~/.agents/permissions/presets/.
 * Also handles ~/.agents-system/permissions/sets/ for system repo.
 * Idempotent: skips if dest already exists or src absent.
 */
function migratePermissionSetsToPresets(): void {
  for (const root of [USER_DIR, SYSTEM_DIR]) {
    const src = path.join(root, 'permissions', 'sets');
    const dest = path.join(root, 'permissions', 'presets');
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      fs.renameSync(src, dest);
      const label = root === USER_DIR ? '~/.agents' : '~/.agents-system';
      console.error(`Migrated ${label}/permissions/sets/ to ${label}/permissions/presets/`);
    } catch { /* best-effort */ }
  }
}

/**
 * After versions are migrated to ~/.agents/versions/, rewrite the per-agent
 * config symlinks (~/.claude, ~/.codex, …) to point at the user-side
 * version-home so the agent CLIs read fresh resources.
 *
 * Idempotent: if the symlink already points at the right user-path target,
 * leave it. If it points at the legacy system path, re-create it. If a real
 * directory exists there (no symlink yet), leave it alone — version-config
 * switching is owned by `agents use`, not the migrator.
 */
function repairAgentConfigSymlinks(): void {
  let yaml: string;
  try {
    yaml = fs.readFileSync(path.join(USER_DIR, 'agents.yaml'), 'utf-8');
  } catch {
    return;
  }
  const agentsBlock = yaml.match(/^agents:\s*\n((?:  [^\n]*\n)+)/m);
  if (!agentsBlock) return;
  const defaults: Array<{ agent: string; version: string }> = [];
  for (const line of agentsBlock[1].split('\n')) {
    const m = line.match(/^\s+([a-z][a-z0-9_-]*):\s*([^\s#]+)/);
    if (m) defaults.push({ agent: m[1], version: m[2] });
  }

  let repaired = 0;
  for (const { agent, version } of defaults) {
    const userTarget = fs.existsSync(path.join(HISTORY_DIR, 'versions', agent, version, 'home', `.${agent}`))
      ? path.join(HISTORY_DIR, 'versions', agent, version, 'home', `.${agent}`)
      : path.join(USER_DIR, 'versions', agent, version, 'home', `.${agent}`);
    if (!fs.existsSync(userTarget)) continue;

    const symlinkPath = path.join(HOME, `.${agent}`);
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(symlinkPath); } catch { /* missing */ }
    if (stat && stat.isSymbolicLink()) {
      let current: string;
      try { current = fs.readlinkSync(symlinkPath); } catch { continue; }
      const resolved = path.resolve(path.dirname(symlinkPath), current);
      if (resolved === path.resolve(userTarget)) continue; // already correct
      try {
        fs.unlinkSync(symlinkPath);
        fs.symlinkSync(userTarget, symlinkPath);
        repaired++;
      } catch { /* best-effort */ }
    } else if (!stat) {
      try {
        fs.symlinkSync(userTarget, symlinkPath);
        repaired++;
      } catch { /* best-effort */ }
    }
  }

  if (repaired > 0) {
    console.error(`Repaired ${repaired} agent config symlink${repaired === 1 ? '' : 's'} to point at ~/.agents/versions/`);
  }
}

/**
 * Move a directory from `src` to `dest`. No-op when src is absent. When dest
 * already exists, merge by copying everything that isn't already there, then
 * remove the source. Idempotent: re-running converges without duplicating.
 *
 * The merge-on-collision behavior matters because `ensureAgentsDir()` may have
 * pre-created an empty `dest` during startup before the migrator gets to run.
 */
function moveDirOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      return;
    } catch {
      /* fall through to copy + remove */
    }
  }

  try {
    copyDirSkipExisting(src, dest);
    fs.rmSync(src, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/**
 * Move a single file from `src` to `dest`. No-op when src is absent. When
 * dest exists, the source is simply deleted (the in-place version is treated
 * as the canonical state). Idempotent.
 */
function moveFileOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch {
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } catch { /* best-effort */ }
  }
}

/** Remove a directory tree if it exists and contains no files (best-effort). */
function rmEmptyDirTree(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const child = path.join(dir, entry);
      try {
        const stat = fs.statSync(child);
        if (stat.isDirectory()) rmEmptyDirTree(child);
      } catch { /* skip */ }
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
}

/**
 * Move durable runtime data into ~/.agents/.history/.
 *
 * Sources cleared:
 *   ~/.agents/sessions/   -> ~/.agents/.history/sessions/
 *   ~/.agents/versions/   -> ~/.agents/.history/versions/
 *   ~/.agents/.trash/     -> ~/.agents/.history/trash/
 *   ~/.agents/.backups/   -> ~/.agents/.history/backups/
 *   ~/.agents/routines/runs/ -> ~/.agents/.history/runs/
 *   ~/.agents/teams/agents/  -> ~/.agents/.history/teams/agents/
 *
 * Idempotent — skips entries whose destination already exists.
 */
function migrateRuntimeToHistory(): void {
  moveDirOnce(path.join(USER_DIR, 'sessions'), path.join(HISTORY_DIR, 'sessions'));
  moveDirOnce(path.join(USER_DIR, 'versions'), path.join(HISTORY_DIR, 'versions'));
  // Some installs left both `.trash/` (current) and `trash/` (legacy lowercase).
  // Move whichever exist into the history bucket.
  moveDirOnce(path.join(USER_DIR, '.trash'), path.join(HISTORY_DIR, 'trash'));
  moveDirOnce(path.join(USER_DIR, 'trash'), path.join(HISTORY_DIR, 'trash'));
  moveDirOnce(path.join(USER_DIR, '.backups'), path.join(HISTORY_DIR, 'backups'));
  moveDirOnce(path.join(USER_DIR, 'routines', 'runs'), path.join(HISTORY_DIR, 'runs'));
  moveDirOnce(path.join(USER_DIR, 'teams', 'agents'), path.join(HISTORY_DIR, 'teams', 'agents'));

  // Drop any empty leftover skeletons created mid-rename (e.g. `versions/<agent>/<v>/home/`
  // recreated by a concurrent process). The real data is already under .history/.
  rmEmptyDirTree(path.join(USER_DIR, 'versions'));
  rmEmptyDirTree(path.join(USER_DIR, 'sessions'));
  // Old empty zero-byte sessions.db at user root is obsolete once the new db lives at
  // .history/sessions/sessions.db.
  const oldSessionsDb = path.join(USER_DIR, 'sessions.db');
  if (fs.existsSync(oldSessionsDb)) {
    try {
      if (fs.statSync(oldSessionsDb).size === 0) fs.unlinkSync(oldSessionsDb);
    } catch { /* best-effort */ }
  }
}

/**
 * Restore plugins from the cache bucket back to the user-root.
 *
 * Earlier releases moved ~/.agents/plugins/ → ~/.agents/.cache/plugins/ as part
 * of `migrateRuntimeToCache`. That was wrong: plugins are user-authored
 * resources (alongside skills/, commands/, hooks/) and belong at the user-root
 * so they're git-tracked. See issue #20.
 *
 * For each ~/.agents/.cache/plugins/<name>/ that the user already has at
 * ~/.agents/plugins/<name>/, the cache copy is left alone — the user-root copy
 * wins. For plugins only present in the cache, the directory is moved back to
 * the user-root. Idempotent.
 */
function migratePluginsBackToUserRoot(): void {
  const cachePlugins = path.join(CACHE_DIR, 'plugins');
  const userPlugins = path.join(USER_DIR, 'plugins');
  if (!fs.existsSync(cachePlugins)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cachePlugins, { withFileTypes: true });
  } catch { return; }

  try {
    fs.mkdirSync(userPlugins, { recursive: true, mode: 0o700 });
  } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(cachePlugins, entry.name);
    const dest = path.join(userPlugins, entry.name);
    if (fs.existsSync(dest)) continue;
    try {
      fs.renameSync(src, dest);
    } catch {
      try {
        copyDirSkipExisting(src, dest);
        fs.rmSync(src, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  }

  // Drop the cache plugins dir if we emptied it.
  try {
    if (fs.readdirSync(cachePlugins).length === 0) fs.rmdirSync(cachePlugins);
  } catch { /* best-effort */ }
}

/**
 * Move regenerable runtime data into ~/.agents/.cache/.
 *
 * Sources cleared:
 *   ~/.agents/shims/         -> ~/.agents/.cache/shims/
 *   ~/.agents/bin/           -> ~/.agents/.cache/bin/
 *   ~/.agents/packages/      -> ~/.agents/.cache/packages/
 *   ~/.agents/cloud/         -> ~/.agents/.cache/cloud/
 *   ~/.agents/drive/         -> ~/.agents/.cache/drive/
 *   ~/.agents/terminals/     -> ~/.agents/.cache/terminals/
 *   ~/.agents/logs/          -> ~/.agents/.cache/logs/
 *   ~/.agents/companion/      -> ~/.agents/.cache/companion/
 *   ~/.agents/runtime/       -> ~/.agents/.cache/state/
 *   ~/.agents/cache/         -> ~/.agents/.cache/   (flatten — already a cache subdir)
 *   ~/.agents/helpers/{daemon,pty,...} -> ~/.agents/.cache/helpers/...
 *   ~/.agents-system/helpers/{daemon,pty,...} -> ~/.agents/.cache/helpers/...
 *   ~/.agents/browser/<profile>/  -> ~/.agents/.cache/browser/<profile>/  (profiles/ dir stays)
 *   ~/.agents-system/.fetch/ -> ~/.agents/.cache/.fetch/
 *
 * Loose dot-files at user root that are runtime caches:
 *   ~/.agents/.cli-version-cache.json -> ~/.agents/.cache/.cli-version-cache.json
 *   ~/.agents/.update-check           -> ~/.agents/.cache/.update-check
 *   ~/.agents/.migrated               -> ~/.agents/.cache/.migrated
 *   ~/.agents/watchdog.log            -> ~/.agents/.cache/logs/watchdog.log
 *
 * Idempotent.
 */
function migrateRuntimeToCache(): void {
  moveDirOnce(path.join(USER_DIR, 'shims'), path.join(CACHE_DIR, 'shims'));
  moveDirOnce(path.join(USER_DIR, 'bin'), path.join(CACHE_DIR, 'bin'));
  moveDirOnce(path.join(USER_DIR, 'packages'), path.join(CACHE_DIR, 'packages'));
  // ~/.agents/plugins/ is intentionally NOT migrated — it is user-authored
  // content (git-tracked), alongside skills/, commands/, hooks/. The reverse
  // migration `migratePluginsBackToUserRoot` reclaims any plugins/ that prior
  // releases moved into ~/.agents/.cache/plugins/. See issue #20.
  moveDirOnce(path.join(USER_DIR, 'cloud'), path.join(CACHE_DIR, 'cloud'));
  moveDirOnce(path.join(USER_DIR, 'drive'), path.join(CACHE_DIR, 'drive'));
  // terminals/ stays at the top level: the agents-cli IDE extension publishes
  // ~/.agents/terminals/live-terminals.json and would race with the move on
  // VS Code restart. Leave the path where the extension expects it.
  moveDirOnce(path.join(USER_DIR, 'logs'), path.join(CACHE_DIR, 'logs'));
  moveDirOnce(path.join(USER_DIR, 'companion'), path.join(CACHE_DIR, 'companion'));
  moveDirOnce(path.join(USER_DIR, 'runtime'), path.join(CACHE_DIR, 'state'));

  // Pre-existing user `cache/` dir (claude usage cache, cloud-runs, etc.) — flatten
  // so it's not confused with the new bucket. Its contents merge into .cache/.
  const oldCache = path.join(USER_DIR, 'cache');
  if (fs.existsSync(oldCache) && fs.statSync(oldCache).isDirectory()) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      copyDirSkipExisting(oldCache, CACHE_DIR);
      fs.rmSync(oldCache, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // helpers/ at user-root and system-root → .cache/helpers/
  for (const root of [USER_DIR, SYSTEM_DIR]) {
    const src = path.join(root, 'helpers');
    if (!fs.existsSync(src)) continue;
    const destBase = path.join(CACHE_DIR, 'helpers');
    try {
      fs.mkdirSync(destBase, { recursive: true, mode: 0o700 });
      copyDirSkipExisting(src, destBase);
      fs.rmSync(src, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // browser runtime — keep browser/profiles/ in place, move everything else under
  // browser/ into .cache/browser/.
  const browserSrc = path.join(USER_DIR, 'browser');
  if (fs.existsSync(browserSrc) && fs.statSync(browserSrc).isDirectory()) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(browserSrc); } catch { /* skip */ }
    for (const entry of entries) {
      if (entry === 'profiles') continue;
      const src = path.join(browserSrc, entry);
      const dest = path.join(CACHE_DIR, 'browser', entry);
      moveDirOnce(src, dest);
    }
  }

  // System-root operational state that should not live in the npm-shipped repo.
  moveDirOnce(path.join(SYSTEM_DIR, '.fetch'), path.join(CACHE_DIR, '.fetch'));
  moveDirOnce(path.join(SYSTEM_DIR, 'browser'), path.join(CACHE_DIR, 'browser'));
  moveDirOnce(path.join(SYSTEM_DIR, 'state'), path.join(CACHE_DIR, 'state'));
  moveDirOnce(path.join(SYSTEM_DIR, 'companion'), path.join(CACHE_DIR, 'companion'));
  moveFileOnce(path.join(SYSTEM_DIR, '.cli-version-cache.json'), path.join(CACHE_DIR, '.cli-version-cache.json'));
  moveFileOnce(path.join(SYSTEM_DIR, '.update-check'), path.join(CACHE_DIR, '.update-check'));
  moveFileOnce(path.join(SYSTEM_DIR, '.migrated'), path.join(CACHE_DIR, '.migrated'));
  moveFileOnce(path.join(SYSTEM_DIR, '.models-cache.json'), path.join(CACHE_DIR, '.models-cache.json'));

  // Loose dot-files at user root that belong in the cache bucket.
  moveFileOnce(path.join(USER_DIR, '.cli-version-cache.json'), path.join(CACHE_DIR, '.cli-version-cache.json'));
  moveFileOnce(path.join(USER_DIR, '.update-check'), path.join(CACHE_DIR, '.update-check'));
  moveFileOnce(path.join(USER_DIR, '.migrated'), path.join(CACHE_DIR, '.migrated'));
  moveFileOnce(path.join(USER_DIR, '.models-cache.json'), path.join(CACHE_DIR, '.models-cache.json'));
  moveFileOnce(path.join(USER_DIR, 'watchdog.log'), path.join(CACHE_DIR, 'logs', 'watchdog.log'));
}

/**
 * Merge a SQLite database file at `src` into the one at `dest`, then delete the
 * source (including its WAL/SHM sidecars). User-side rows win on collision via
 * INSERT OR IGNORE.
 *
 * If `dest` is missing, the source is simply moved into place (no merge). If
 * the SQLite open fails (corrupt / zero-byte / locked), the source is dropped
 * so the system repo returns to npm-shipped state — the data is stale-anyway
 * runtime state, not user resources.
 */
async function mergeSqliteDb(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(src)) return;
  try {
    if (fs.statSync(src).size === 0) {
      // Zero-byte legacy DB — drop sidecars too and leave dest alone.
      try { fs.unlinkSync(src); } catch { /* best-effort */ }
      for (const ext of ['-shm', '-wal']) {
        try { fs.unlinkSync(src + ext); } catch { /* best-effort */ }
      }
      return;
    }
  } catch { /* best-effort */ }

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      for (const ext of ['-shm', '-wal']) {
        if (fs.existsSync(src + ext)) {
          try { fs.renameSync(src + ext, dest + ext); } catch { /* best-effort */ }
        }
      }
      return;
    } catch { /* fall through to merge */ }
  }

  // Both files exist — open the dest DB and ATTACH src, then INSERT OR IGNORE
  // every user table. Dynamic import keeps the sqlite shim off the hot path
  // for CLI starts that don't actually need a merge.
  try {
    const sqliteMod = (await import('./sqlite.js')) as { default: new (file: string) => SqliteLike };
    const Database = sqliteMod.default;
    const db = new Database(dest);
    try {
      db.exec(`ATTACH DATABASE '${src.replace(/'/g, "''")}' AS src`);
      const tables = db.prepare<{ name: string }>(
        `SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      ).all() as Array<{ name: string }>;
      // FTS5 virtual tables maintain shadow tables (<name>_data, _idx, _content,
      // _docsize, _config) with internal segids/pgnos that MUST stay consistent.
      // Row-merging shadow tables across two DBs corrupts the index. Skip them
      // here — the indexer reconstructs FTS content on the next scan.
      const ftsVirtuals = new Set<string>(
        (db.prepare<{ name: string }>(
          `SELECT name FROM src.sqlite_master WHERE type='table' AND sql LIKE '%fts5%'`,
        ).all() as Array<{ name: string }>).map((r) => r.name),
      );
      const ftsShadowSuffixes = ['_data', '_idx', '_content', '_docsize', '_config'];
      const isFtsShadow = (name: string): boolean => {
        for (const v of ftsVirtuals) {
          for (const suf of ftsShadowSuffixes) {
            if (name === `${v}${suf}`) return true;
          }
        }
        return false;
      };
      for (const { name } of tables) {
        if (ftsVirtuals.has(name) || isFtsShadow(name)) continue;
        try {
          const row = db.prepare<{ sql: string }>(
            `SELECT sql FROM src.sqlite_master WHERE type='table' AND name = ?`,
          ).get(name) as { sql?: string } | undefined;
          if (row?.sql) {
            const ddl = row.sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
            db.exec(ddl);
          }
        } catch { /* table likely exists already */ }
        const quoted = '"' + name.replace(/"/g, '""') + '"';
        try {
          db.exec(`INSERT OR IGNORE INTO main.${quoted} SELECT * FROM src.${quoted}`);
        } catch { /* schema drift — skip table */ }
      }
      try { db.exec('DETACH DATABASE src'); } catch { /* best-effort */ }
    } finally {
      try { db.close(); } catch { /* best-effort */ }
    }
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    for (const ext of ['-shm', '-wal']) {
      try { fs.unlinkSync(src + ext); } catch { /* best-effort */ }
    }
  } catch {
    // Merge failed — drop the source so the system repo returns to clean state.
    // The user-side DB is authoritative; system-side rows were duplicate state.
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    for (const ext of ['-shm', '-wal']) {
      try { fs.unlinkSync(src + ext); } catch { /* best-effort */ }
    }
  }
}

interface SqliteLike {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  close(): void;
}

/**
 * Move ~/.agents-system/sessions/ into ~/.agents/.history/sessions/.
 *
 * Filesystem entries (claude/, index.jsonl, content_index.jsonl, etc.) merge
 * directory-by-directory with user-side winning on collision. The bundled
 * sessions.db (plus WAL/SHM) goes through mergeSqliteDb so historical rows
 * land in the user DB.
 */
async function migrateSystemSessionsToHistory(): Promise<void> {
  const src = path.join(SYSTEM_DIR, 'sessions');
  if (!fs.existsSync(src)) return;
  const dest = path.join(HISTORY_DIR, 'sessions');
  try { fs.mkdirSync(dest, { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const s = path.join(src, entry.name);
    if (entry.name === 'sessions.db' || entry.name === 'sessions.db-shm' || entry.name === 'sessions.db-wal') {
      // Handled by mergeSqliteDb on the canonical .db name below.
      continue;
    }
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      moveDirOnce(s, d);
    } else {
      moveFileOnce(s, d);
    }
  }

  await mergeSqliteDb(path.join(src, 'sessions.db'), path.join(dest, 'sessions.db'));

  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/teams/ contents to ~/.agents/teams/ (registry/config)
 * and ~/.agents/.history/teams/ (per-run dirs).
 *
 * Strategy:
 *   config.json, registry.json   -> ~/.agents/teams/        (live state)
 *   agents/                       -> ~/.agents/.history/teams/agents/
 *   <anything else>               -> ~/.agents/.history/teams/<name>/  (per-run dirs)
 */
function migrateSystemTeamsToUser(): void {
  const src = path.join(SYSTEM_DIR, 'teams');
  if (!fs.existsSync(src)) return;
  const liveDest = path.join(USER_DIR, 'teams');
  const historyDest = path.join(HISTORY_DIR, 'teams');

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const s = path.join(src, entry.name);
    if (entry.name === 'config.json' || entry.name === 'registry.json') {
      moveFileOnce(s, path.join(liveDest, entry.name));
      continue;
    }
    if (entry.name === 'agents' && entry.isDirectory()) {
      moveDirOnce(s, path.join(historyDest, 'agents'));
      continue;
    }
    if (entry.isDirectory()) {
      moveDirOnce(s, path.join(historyDest, entry.name));
    } else {
      moveFileOnce(s, path.join(historyDest, entry.name));
    }
  }

  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/trash/ -> ~/.agents/.history/trash/.
 *
 * The system trash was where the legacy `mergeOverlappingVersionHomes()` parked
 * orphan version homes. Folding it into the history bucket keeps "everything
 * recoverable" in one place.
 */
function migrateSystemTrashToHistory(): void {
  const src = path.join(SYSTEM_DIR, 'trash');
  if (!fs.existsSync(src)) return;
  moveDirOnce(src, path.join(HISTORY_DIR, 'trash'));
}

/**
 * Move ~/.agents-system/cache/ contents into ~/.agents/.cache/.
 *
 * Special cases:
 *   sessions.db        -> mergeSqliteDb into HISTORY_DIR/sessions/sessions.db
 *   cloud-runs/        -> .cache/cloud-runs/
 *   claude-usage.json  -> drop (regenerable per-version cache)
 *   <anything else>    -> .cache/<name> (merge-on-collision)
 */
async function migrateSystemCacheToUserCache(): Promise<void> {
  const src = path.join(SYSTEM_DIR, 'cache');
  if (!fs.existsSync(src)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const s = path.join(src, entry.name);
    if (entry.name === 'sessions.db' || entry.name === 'sessions.db-shm' || entry.name === 'sessions.db-wal') {
      // Sessions DB belongs in HISTORY, not CACHE — merge into the durable one.
      if (entry.name === 'sessions.db') {
        await mergeSqliteDb(s, path.join(HISTORY_DIR, 'sessions', 'sessions.db'));
      }
      // Sidecars get dropped if they outlived the merge or were orphaned.
      try { if (fs.existsSync(s)) fs.unlinkSync(s); } catch { /* best-effort */ }
      continue;
    }
    if (entry.name === 'claude-usage.json') {
      try { fs.unlinkSync(s); } catch { /* best-effort */ }
      continue;
    }
    const d = path.join(CACHE_DIR, entry.name);
    if (entry.isDirectory()) {
      moveDirOnce(s, d);
    } else {
      moveFileOnce(s, d);
    }
  }

  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
}

/**
 * Merge ~/.agents-system/cloud/tasks.db into ~/.agents/.cache/cloud/tasks.db.
 */
async function migrateSystemCloudToCache(): Promise<void> {
  const srcDir = path.join(SYSTEM_DIR, 'cloud');
  if (!fs.existsSync(srcDir)) return;
  await mergeSqliteDb(path.join(srcDir, 'tasks.db'), path.join(CACHE_DIR, 'cloud', 'tasks.db'));

  // Any other files in cloud/ get moved into the user cache bucket.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(CACHE_DIR, 'cloud', entry.name);
    if (entry.isDirectory()) {
      moveDirOnce(s, d);
    } else {
      moveFileOnce(s, d);
    }
  }
  try {
    if (fs.readdirSync(srcDir).length === 0) fs.rmdirSync(srcDir);
  } catch { /* best-effort */ }
}

/**
 * Legacy ~/.agents-system/swarm/ predates the rename to teams/. Fold any
 * per-agent dirs into ~/.agents/.history/teams/agents/ and drop the bookkeeping
 * JSONs (cache.json, config.json, teams.json) — those are regenerable.
 */
function migrateLegacySwarmToTeams(): void {
  const src = path.join(SYSTEM_DIR, 'swarm');
  if (!fs.existsSync(src)) return;
  const agentsSrc = path.join(src, 'agents');
  if (fs.existsSync(agentsSrc)) {
    moveDirOnce(agentsSrc, path.join(HISTORY_DIR, 'teams', 'agents'));
  }
  for (const dead of ['cache.json', 'config.json', 'teams.json']) {
    const f = path.join(src, dead);
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }
  }
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/repos/<alias>/ to ~/.agents-<alias>/ peer dirs.
 *
 * Extra DotAgents repos are user-defined config and belong as peer dirs to
 * ~/.agents/, not nested under the npm-shipped system repo. The dir name in
 * `repos/` becomes the alias.
 */
function migrateSystemReposToPeerDirs(): void {
  const src = path.join(SYSTEM_DIR, 'repos');
  if (!fs.existsSync(src)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  let moved = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const alias = entry.name;
    const s = path.join(src, alias);
    const d = path.join(HOME, `.agents-${alias}`);
    if (fs.existsSync(d)) {
      // Peer dir already exists — drop the system-side copy to avoid drift.
      try { fs.rmSync(s, { recursive: true, force: true }); } catch { /* best-effort */ }
      continue;
    }
    try {
      fs.renameSync(s, d);
      moved++;
    } catch { /* best-effort, leave in place */ }
  }
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
  if (moved > 0) {
    console.error(`Moved ${moved} extra repo${moved === 1 ? '' : 's'} from ~/.agents-system/repos/ to ~/.agents-<alias>/ peer dirs`);
  }
}

/**
 * Drop known-dead artifacts from ~/.agents-system/ that are pure regenerable
 * runtime state and don't belong anywhere:
 *   bin/agents-keychain-*  — per-version keychain helper, rebuilt on demand
 *   shims/                  — moved long ago, only empty leftover remains
 */
function dropDeadSystemArtifacts(): void {
  const binDir = path.join(SYSTEM_DIR, 'bin');
  if (fs.existsSync(binDir)) {
    try {
      for (const name of fs.readdirSync(binDir)) {
        if (name.startsWith('agents-keychain-')) {
          try { fs.unlinkSync(path.join(binDir, name)); } catch { /* best-effort */ }
        }
      }
      if (fs.readdirSync(binDir).length === 0) fs.rmdirSync(binDir);
    } catch { /* best-effort */ }
  }

  const shimsDir = path.join(SYSTEM_DIR, 'shims');
  if (fs.existsSync(shimsDir)) {
    try {
      if (fs.readdirSync(shimsDir).length === 0) fs.rmdirSync(shimsDir);
    } catch { /* best-effort */ }
  }

  // After migrateSystemVersionsToUser() moves real version dirs out, the system
  // may still hold an empty `versions/<agent>/` skeleton with a stray .DS_Store.
  // Sweep it: if every leaf file is .DS_Store, drop the tree entirely.
  const versionsDir = path.join(SYSTEM_DIR, 'versions');
  if (fs.existsSync(versionsDir)) {
    try {
      if (containsOnlyDsStore(versionsDir)) {
        fs.rmSync(versionsDir, { recursive: true, force: true });
      }
    } catch { /* best-effort */ }
  }
}

function containsOnlyDsStore(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!containsOnlyDsStore(path.join(dir, entry.name))) return false;
    } else if (entry.name !== '.DS_Store') {
      return false;
    }
  }
  return true;
}

/**
 * After the sweep runs, warn (once per invocation) about any unrecognized
 * subdirectory left in ~/.agents-system/. The system repo is the npm-shipped
 * defaults — anything outside the allowlist is drift that future maintainers
 * need to handle explicitly.
 */
function warnSystemOrphans(): void {
  const SHIPPED_ALLOWLIST = new Set<string>([
    // resource directories shipped by the npm package
    'commands', 'hooks', 'skills', 'rules', 'mcp', 'cli', 'permissions', 'subagents', 'profiles', 'agents',
    // top-level metadata files
    'agents.yaml', 'hooks.yaml', 'README.md', 'CHANGELOG.md',
    // git + repo metadata
    '.git', '.githooks', '.gitignore', '.assets', '.environment', '.plans',
    // benign noise that's safe to ignore
    '.DS_Store', '.claude',
  ]);

  let entries: string[];
  try {
    entries = fs.readdirSync(SYSTEM_DIR);
  } catch {
    return;
  }
  // Transient runtime sockets (.sock) are bound by long-running helpers like the
  // VS Code extension; they're live state, not stale data, and a future fix in
  // those helpers will move them into ~/.agents/.cache/ — until then, suppress.
  const orphans = entries.filter((name) => !SHIPPED_ALLOWLIST.has(name) && !name.endsWith('.sock'));
  if (orphans.length === 0) return;
  console.error(`~/.agents-system/ has unexpected entries (not part of the npm-shipped defaults): ${orphans.join(', ')}`);
}

const VERSION_RESOURCE_FLAT_KEYS = ['commands', 'skills', 'hooks', 'memory', 'subagents', 'plugins', 'workflows', 'permissions', 'mcp'] as const;

/**
 * Convert agents.yaml versions: entries from the old flat name-list format to
 * the new pattern format. Flat entries are detected by checking whether all
 * items in the array lack a ':' separator (plain names have no source prefix).
 *
 * The rulesPreset field is preserved. Flat resource lists are dropped — the
 * next `agents sync` will write default patterns (system:* user:* project:*).
 *
 * Idempotent: entries already in pattern format are left untouched.
 */
function migrateVersionResourcesToPatterns(): void {
  const metaFile = path.join(USER_DIR, 'agents.yaml');
  if (!fs.existsSync(metaFile)) return;

  let meta: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(metaFile, 'utf-8');
    meta = (yaml.parse(raw) as Record<string, unknown>) || {};
  } catch { return; }

  const versions = meta.versions as Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (!versions || typeof versions !== 'object') return;

  let changed = false;
  for (const agentVersions of Object.values(versions)) {
    if (!agentVersions || typeof agentVersions !== 'object') continue;
    for (const vr of Object.values(agentVersions)) {
      if (!vr || typeof vr !== 'object') continue;
      for (const key of VERSION_RESOURCE_FLAT_KEYS) {
        const val = vr[key];
        if (!Array.isArray(val) || val.length === 0) continue;
        // Detect legacy: all items are plain names (no ':' separator)
        if ((val as string[]).every(item => typeof item === 'string' && !item.includes(':'))) {
          if (key === 'memory') {
            // memory was a single-element array holding the preset name — move to rulesPreset
            if ((val as string[]).length === 1 && !vr['rulesPreset']) {
              vr['rulesPreset'] = (val as string[])[0];
            }
          }
          delete vr[key];
          changed = true;
        }
      }
    }
  }

  if (changed) {
    const META_HEADER = '# agents-cli metadata\n# Auto-generated - do not edit manually\n# https://github.com/phnx-labs/agents-cli\n\n';
    fs.writeFileSync(metaFile, META_HEADER + yaml.stringify(meta), 'utf-8');
    console.error('Migrated agents.yaml versions: entries to pattern format');
  }
}

/**
 * Rename the legacy `extras-extras/` plugin-marketplace dir to `agents-extras/`
 * inside every installed agent version-home, and rewrite cross-references in
 * `known_marketplaces.json` and the agent's `settings.json`.
 *
 * A previous dev build of `agents-cli` named the extras-aliased repo's
 * synthesized marketplace dir `extras-extras` (double "extras" because the alias
 * itself was `extras`). The new naming convention is `agents-<alias>`, so the
 * directory should be `agents-extras`. Without this migration the orphan dir
 * stays on disk and Claude Code loads two parallel marketplaces (the legacy
 * `extras-extras` entry from `known_marketplaces.json` plus the freshly
 * synthesized `agents-extras` from the new code path).
 *
 * Strategy per `<historyDir>/versions/<agent>/<ver>/home/.<agent>/plugins/`:
 *   1. `marketplaces/extras-extras/` → `marketplaces/agents-extras/`
 *      (drops `extras-extras/` outright when `agents-extras/` already exists —
 *      previous incomplete migration ran)
 *   2. Inside the renamed dir's `.claude-plugin/marketplace.json`, set
 *      `"name": "agents-extras"`.
 *   3. In `<configDir>/plugins/known_marketplaces.json`, rename the
 *      `extras-extras` key to `agents-extras` and rewrite `source.path` /
 *      `installLocation`.
 *   4. In `<configDir>/settings.json`'s `enabledPlugins`, rename every
 *      `<plugin>@extras-extras` key to `<plugin>@agents-extras` (preserving
 *      its boolean value, skipping if the new key already exists).
 *
 * Idempotent: re-running converges without further writes once everything is on
 * the new name.
 */
export function migrateExtrasExtrasToAgentsExtras(historyDir: string = HISTORY_DIR): void {
  const versionsRoot = path.join(historyDir, 'versions');
  if (!fs.existsSync(versionsRoot)) return;

  const OLD = 'extras-extras';
  const NEW = 'agents-extras';

  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(versionsRoot, { withFileTypes: true });
  } catch { return; }

  let renamedDirs = 0;
  let rewroteKnown = 0;
  let rewroteSettings = 0;

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentId = agentEntry.name;
    const agentVersionsDir = path.join(versionsRoot, agentId);

    let verEntries: fs.Dirent[];
    try {
      verEntries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
    } catch { continue; }

    for (const ver of verEntries) {
      if (!ver.isDirectory()) continue;
      const configDir = path.join(agentVersionsDir, ver.name, 'home', `.${agentId}`);
      const pluginsDir = path.join(configDir, 'plugins');
      if (!fs.existsSync(pluginsDir)) continue;

      const marketplacesDir = path.join(pluginsDir, 'marketplaces');
      const oldDir = path.join(marketplacesDir, OLD);
      const newDir = path.join(marketplacesDir, NEW);
      const oldExists = fs.existsSync(oldDir);
      const newExists = fs.existsSync(newDir);

      if (oldExists && !newExists) {
        try {
          fs.renameSync(oldDir, newDir);
          renamedDirs++;
        } catch { /* best-effort, leave orphan */ }
      } else if (oldExists && newExists) {
        // Previous incomplete migration — drop the stale old dir.
        try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }

      // Rewrite marketplace.json name field inside the (now) agents-extras dir.
      const marketplaceJson = path.join(newDir, '.claude-plugin', 'marketplace.json');
      if (fs.existsSync(marketplaceJson)) {
        try {
          const raw = fs.readFileSync(marketplaceJson, 'utf-8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed?.name === OLD) {
            parsed.name = NEW;
            fs.writeFileSync(marketplaceJson, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
          }
        } catch { /* best-effort */ }
      }

      // Rewrite known_marketplaces.json key + path fields.
      const knownFile = path.join(pluginsDir, 'known_marketplaces.json');
      if (fs.existsSync(knownFile)) {
        try {
          const raw = fs.readFileSync(knownFile, 'utf-8');
          const known = JSON.parse(raw) as Record<string, {
            source?: { source?: string; path?: string; repo?: string };
            installLocation?: string;
            lastUpdated?: string;
          }>;
          if (known && typeof known === 'object' && OLD in known) {
            const entry = known[OLD];
            if (!(NEW in known)) {
              if (entry?.source?.path) entry.source.path = entry.source.path.split(OLD).join(NEW);
              if (entry?.installLocation) entry.installLocation = entry.installLocation.split(OLD).join(NEW);
              known[NEW] = entry;
            }
            delete known[OLD];
            fs.writeFileSync(knownFile, JSON.stringify(known, null, 2) + '\n', 'utf-8');
            rewroteKnown++;
          }
        } catch { /* best-effort */ }
      }

      // Rewrite settings.json enabledPlugins keys.
      const settingsFile = path.join(configDir, 'settings.json');
      if (fs.existsSync(settingsFile)) {
        try {
          const raw = fs.readFileSync(settingsFile, 'utf-8');
          const settings = JSON.parse(raw) as Record<string, unknown>;
          const enabled = settings?.enabledPlugins as Record<string, boolean> | undefined;
          if (enabled && typeof enabled === 'object') {
            const suffix = `@${OLD}`;
            const newSuffix = `@${NEW}`;
            let changed = false;
            for (const key of Object.keys(enabled)) {
              if (!key.endsWith(suffix)) continue;
              const renamed = key.slice(0, -suffix.length) + newSuffix;
              if (renamed in enabled) {
                delete enabled[key];
              } else {
                enabled[renamed] = enabled[key];
                delete enabled[key];
              }
              changed = true;
            }
            if (changed) {
              fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
              rewroteSettings++;
            }
          }
        } catch { /* best-effort */ }
      }
    }
  }

  if (renamedDirs > 0 || rewroteKnown > 0 || rewroteSettings > 0) {
    console.error(`Renamed extras-extras → agents-extras (dirs: ${renamedDirs}, known_marketplaces: ${rewroteKnown}, settings: ${rewroteSettings})`);
  }
}

/** Run all idempotent migrations. Safe to call multiple times. */
export async function runMigration(): Promise<void> {
  // MUST run first: every other migrator reads SYSTEM_DIR (the new path).
  foldLegacySystemRepo();
  migrateAgentsYaml();
  deleteSystemPromptsJson();
  migrateSystemConfigJson();
  migratePromptcutsIntoHooks();
  migrateSystemVersionsToUser();
  mergeOverlappingVersionHomes();
  migrateRunsIntoRoutines();
  migrateTrashToHidden();
  migrateBackupsToHidden();
  migrateAliasesToUser();
  migratePermissionSetsToPresets();
  deleteUserLinearJson();
  deleteUserPromptsJson();
  deleteTeamsConfigJson();
  moveTeamsRegistryToHistory();
  cleanupUserConfigJson();
  cleanupEmptyTopLevelRuns();
  foldUserHooksYamlIntoAgentsYaml();
  foldBrowserProfilesIntoAgentsYaml();
  migrateVersionResourcesToPatterns();
  // Bucket moves: collapse runtime state into ~/.agents/.history and ~/.agents/.cache.
  migrateRuntimeToHistory();
  migrateRuntimeToCache();
  // Restore plugins (user-authored) from cache back to user-root. Runs AFTER
  // migrateRuntimeToCache so any legacy plugins/ still at the user-root from
  // very-old layouts have already been handled.
  migratePluginsBackToUserRoot();

  // System-repo sweep: move every remaining operational dir into its canonical
  // user-bucket location, then drop known-dead artifacts and warn about
  // anything we don't recognize. Order: durable (sessions/teams/trash/repos/
  // legacy-swarm) -> caches (cache/, cloud/) -> drops -> orphan check.
  await migrateSystemSessionsToHistory();
  migrateSystemTeamsToUser();
  migrateSystemTrashToHistory();
  migrateLegacySwarmToTeams();
  migrateSystemReposToPeerDirs();
  await migrateSystemCacheToUserCache();
  await migrateSystemCloudToCache();
  dropDeadSystemArtifacts();
  warnSystemOrphans();

  // Rename the legacy extras-extras marketplace dir to agents-extras across every
  // installed version-home. Runs after migrateRuntimeToHistory so the version
  // homes are at their canonical HISTORY_DIR location.
  migrateExtrasExtrasToAgentsExtras();

  // Symlink repair runs LAST so it can find the post-move version homes.
  repairAgentConfigSymlinks();
}
