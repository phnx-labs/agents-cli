import * as vscode from 'vscode';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { bootstrapPath, resolveAgentsBin } from '../core/agentsBin';

// The extension holds NO watchdog loop. The CLI daemon watchdog
// (`agents watchdog enable`, running under `agents __daemon-run`) is the sole
// watchdog: it owns stall-nudging AND rotate-on-exhaustion, injecting into
// vscodium tabs through the extension's `/inject` URI verb over
// live-terminals.json, and writing the shared `~/.agents/.cache/logs/
// watchdog.log` feed the Fleet status card reads (core/watchdogLog.ts).
//
// What remains here:
//   1. The palette on/off — `Agents: Watchdog (Enable|Disable)` shell out to
//      the CLI's existing `agents watchdog enable|disable` switch.
//   2. The one-time settings migration (deleted `agents.watchdog.*` settings).
//   3. The user-editable playbook file scaffold — the CLI daemon owns nudging
//      now, so this file drives no in-extension behavior; the helpers stay
//      because the Fleet settings panel still surfaces it for editing.

// --- Playbook scaffold (surfaced by the settings panel) ---------------------

export const WATCHDOG_PLAYBOOK_PATH = path.join(
  os.homedir(),
  '.agents',
  'playbooks',
  'watchdog.md'
);

const WATCHDOG_PLAYBOOK_TEMPLATE = `# Watchdog Playbook

House rules for the Watchdog. Add patterns you've observed. One rule per bullet.
Be specific.

## Nudge recipes

- When the agent says "I'll write/create/run X" with no matching tool call
  in the next 30 seconds, nudge: "Do it now."

## Skip rules

- Skip if the last assistant message ends with a question mark — user input expected.

## Project-specific

- (Add rules tied to your repos here.)
`;

export function ensureWatchdogPlaybookScaffold(): void {
  if (fsSync.existsSync(WATCHDOG_PLAYBOOK_PATH)) return;
  fsSync.mkdirSync(path.dirname(WATCHDOG_PLAYBOOK_PATH), { recursive: true });
  fsSync.writeFileSync(WATCHDOG_PLAYBOOK_PATH, WATCHDOG_PLAYBOOK_TEMPLATE, 'utf8');
}

export interface WatchdogPlaybookStatus {
  exists: boolean;
  lines: number;
  mtimeMs: number;
}

export function getWatchdogPlaybookStatus(): WatchdogPlaybookStatus {
  try {
    const stat = fsSync.statSync(WATCHDOG_PLAYBOOK_PATH);
    const content = fsSync.readFileSync(WATCHDOG_PLAYBOOK_PATH, 'utf8');
    return {
      exists: true,
      lines: content.split('\n').filter((l) => l.trim().length > 0).length,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return { exists: false, lines: 0, mtimeMs: 0 };
  }
}

// --- CLI-backed enable/disable ----------------------------------------------

export type WatchdogCliAction = 'enable' | 'disable';

/**
 * The exec seam (injected by tests): a promisified `child_process.execFile` —
 * argv array, never a shell string.
 */
export type ExecFileAsync = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface WatchdogCliDeps {
  execFileAsync?: ExecFileAsync;
  resolveBin?: () => Promise<string>;
}

const defaultExecFileAsync: ExecFileAsync = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        (error as { stderr?: string }).stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

/**
 * Run `agents watchdog <args...>` against the resolved CLI binary (argv array,
 * never a shell string). Resolves on a clean exit; throws an Error whose
 * message quotes the CLI's stderr on a nonzero exit.
 */
export async function runWatchdogCli(
  args: string[],
  deps: WatchdogCliDeps = {},
): Promise<void> {
  const bin = await (deps.resolveBin ?? resolveAgentsBin)();
  const env = {
    ...process.env,
    PATH: `${bootstrapPath(bin)}:${process.env.PATH ?? ''}`,
  };
  try {
    await (deps.execFileAsync ?? defaultExecFileAsync)(bin, ['watchdog', ...args], { env });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * `Agents: Watchdog (Enable)` / `Agents: Watchdog (Disable)` — the on/off for
 * the CLI daemon watchdog (nudging + rotate). Static palette titles can't be
 * dynamic, so the pair is the honest version of a toggle.
 */
export function registerWatchdogPaletteCommands(
  registerCommand: typeof vscode.commands.registerCommand,
  deps: WatchdogCliDeps = {},
): vscode.Disposable[] {
  const handler = (action: WatchdogCliAction) => async () => {
    try {
      await runWatchdogCli([action], deps);
      vscode.window.setStatusBarMessage(`Watchdog ${action}d (CLI daemon)`, 4000);
    } catch (err) {
      vscode.window.showErrorMessage(
        `agents watchdog ${action} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  return [
    registerCommand('agents.watchdogEnable', handler('enable')),
    registerCommand('agents.watchdogDisable', handler('disable')),
  ];
}

// --- One-time settings migration ----------------------------------------------

/** globalState flag: the autoRotate migration runs at most once per user. */
export const WATCHDOG_ROTATE_MIGRATED_KEY = 'agents.watchdogRotateMigrated';

interface GlobalStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

interface AutoRotateSettingInspect {
  globalValue?: boolean;
  workspaceValue?: boolean;
  workspaceFolderValue?: boolean;
}

export interface AutoRotateMigrationDeps extends WatchdogCliDeps {
  inspectAutoRotate?: () => AutoRotateSettingInspect | undefined;
  setStatusBarMessage?: (message: string, hideAfterTimeout: number) => void;
  showErrorMessage?: (message: string) => void;
}

/**
 * The `agents.watchdog.*` settings were deleted with the in-extension loop. A
 * user who explicitly set `agents.watchdog.autoRotate: false` opted OUT of
 * rotate — upgrading must not silently re-enable it now that the CLI daemon
 * owns rotate. The migration is the CLI's ROTATE-ONLY switch,
 * `agents watchdog rotate off` (persists `watchdog.rotate: 'off'` in the CLI
 * meta config) — never `agents watchdog disable`, which would pause nudging
 * too for a user who only opted out of rotate.
 *
 * Requires an agents-cli new enough to ship the `watchdog rotate` subcommand
 * (it lands with the CLI half of this change). On an OLDER CLI the subcommand
 * is unknown and the exit is nonzero: the migration fails, leaves the
 * globalState flag unset, and retries on the next activation — the honest
 * failure mode. There is deliberately no fallback to full `disable`.
 */
export async function migrateAutoRotateSettingOnce(
  globalState: GlobalStateLike,
  deps: AutoRotateMigrationDeps = {},
): Promise<void> {
  if (globalState.get<boolean>(WATCHDOG_ROTATE_MIGRATED_KEY)) return;

  const inspect = deps.inspectAutoRotate?.() ?? vscode.workspace
    .getConfiguration('agents.watchdog')
    .inspect<boolean>('autoRotate');
  const explicitOff =
    inspect?.globalValue === false ||
    inspect?.workspaceValue === false ||
    inspect?.workspaceFolderValue === false;

  if (!explicitOff) {
    await globalState.update(WATCHDOG_ROTATE_MIGRATED_KEY, true);
    return;
  }

  try {
    await runWatchdogCli(['rotate', 'off'], deps);
    await globalState.update(WATCHDOG_ROTATE_MIGRATED_KEY, true);
    (deps.setStatusBarMessage ?? ((message, timeout) => {
      vscode.window.setStatusBarMessage(message, timeout);
    }))(
      'Migrated watchdog setting: auto-rotate was off — CLI watchdog rotate is off (`agents watchdog rotate on` re-enables)',
      8000,
    );
  } catch (err) {
    console.warn('[WATCHDOG] autoRotate migration failed (will retry next activation):', err);
    (deps.showErrorMessage ?? ((message) => {
      void vscode.window.showErrorMessage(message);
    }))(
      `Could not migrate the removed agents.watchdog.autoRotate setting: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
