/**
 * VSCodium agent-terminal backend — opens an agent terminal in a VSCodium /
 * Cursor / VS Code window via the swarmify `swarm-ext` extension's URI handler.
 *
 * Unlike iTerm/Ghostty (GUI terminal apps driven by AppleScript), the editor is
 * already running; we hand it a `<scheme>://swarmify.swarm-ext/spawn?…` URL via
 * the editor CLI's `--open-url` flag. The extension opens an editor-tab terminal
 * in `cwd`, runs `command`, and its shell-adoption promotes a resume command
 * (e.g. `claude --resume <id>`) to the matching agent chip. Driving the editor
 * CLI (not macOS `open`) means this works over `--host` SSH and on Linux, needs
 * no OS URL-scheme handler registration, and sends the command into an
 * already-interactive login shell — so no `zsh -ilc` wrap (the other backends'
 * wrapper) is applied here.
 */
import * as fs from 'fs';
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';

/** The swarmify extension identifier that owns the `/spawn` URI verb. */
const EXTENSION_AUTHORITY = 'swarmify.swarm-ext';

/** An editor flavour that speaks the swarm-ext URI protocol. */
export interface EditorVariant {
  /** CLI on PATH, invoked with `--open-url`. */
  cli: string;
  /** URL scheme the product registers (must match the CLI's product). */
  scheme: string;
  /** macOS app bundle, for local availability detection. */
  app: string;
  label: string;
}

/**
 * Known editors, in preference order. VSCodium first — the backend is named for
 * it and is the user's editor; Cursor and VS Code also ship the extension and
 * are wired here for `makeVscodiumAgentBackend` / future registration.
 */
export const EDITOR_VARIANTS: EditorVariant[] = [
  { cli: 'codium', scheme: 'vscodium', app: '/Applications/VSCodium.app', label: 'VSCodium' },
  { cli: 'cursor', scheme: 'cursor', app: '/Applications/Cursor.app', label: 'Cursor' },
  { cli: 'code', scheme: 'vscode', app: '/Applications/Visual Studio Code.app', label: 'VS Code' },
];

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * The `<scheme>://swarmify.swarm-ext/spawn?p=<payload>` URL the extension handles.
 *
 * The payload is base64url-encoded JSON in a single `p` param — NOT one param per
 * field. VS Code percent-*decodes* `uri.query` once before the extension parses
 * it, so a `command`/`cwd` containing `&` (or `=`) would be mis-split by a naive
 * multi-param query. base64url is `[A-Za-z0-9_-]` only (no `&`, `=`, `%`, `+`,
 * `/`), so it survives that decode untouched and round-trips exactly.
 */
export function spawnUri(
  scheme: string,
  cwd: string,
  command: string[],
  direction?: SplitDirection,
): string {
  const payload: { command: string; cwd: string; split?: SplitDirection } = {
    command: command.join(' '),
    cwd,
  };
  if (direction) payload.split = direction;
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${scheme}://${EXTENSION_AUTHORITY}/spawn?p=${p}`;
}

/** Build a backend bound to one editor variant. */
export function makeVscodiumAgentBackend(variant: EditorVariant): TerminalBackend {
  return {
    id: 'vscodium-agent',
    label: `${variant.label} agent`,
    isAvailable(ctx: EngineContext): boolean {
      return ctx.platform === 'darwin' && appExists(variant.app);
    },
    buildTab(cwd: string, command: string[]): LaunchSpec {
      return { argv: [variant.cli, '--open-url', spawnUri(variant.scheme, cwd, command)] };
    },
    buildSplit(cwd: string, command: string[], direction: SplitDirection): LaunchSpec {
      return { argv: [variant.cli, '--open-url', spawnUri(variant.scheme, cwd, command, direction)] };
    },
  };
}

/** Default backend: VSCodium (`codium` CLI, `vscodium://` scheme). */
export const vscodiumAgentBackend: TerminalBackend = makeVscodiumAgentBackend(EDITOR_VARIANTS[0]);
