/**
 * Core types for the terminal launch engine.
 *
 * The engine opens an *interactive* surface — a tab or a split pane — running a
 * command, in a chosen terminal backend (iTerm / Ghostty / tmux), on this
 * machine or a remote host. This is distinct from cloud providers
 * (src/lib/cloud), which dispatch autonomous headless tasks; a terminal surface
 * is attended and live. See docs/terminal-engine.md.
 */

/** An interactive terminal backend the engine can drive. */
export type Backend = 'iterm' | 'ghostty' | 'tmux' | 'vscodium-agent';

/** Which way a split pane grows. `right` = side-by-side; `down` = stacked. */
export type SplitDirection = 'right' | 'down';

/** Where a surface lands: a new tab, or a split of the current pane. */
export type Layout = 'tab' | 'split-right' | 'split-down';

/** Ambient facts a backend needs to decide availability and detection. */
export interface EngineContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** Snapshot the live process context. */
export function currentContext(): EngineContext {
  return { platform: process.platform, env: process.env };
}

/** The concrete OS command that opens a surface — the pure output of a backend. */
export interface LaunchSpec {
  /** argv to run (e.g. `['osascript','-e',script]` or `['tmux','split-window',…]`). */
  argv: string[];
}

/** A single "open this command as this surface" instruction. */
export interface LaunchRequest {
  backend: Backend;
  layout: Layout;
  /** Working directory the command runs in. */
  cwd: string;
  /** argv to exec in the surface (e.g. a resume command). */
  command: string[];
  /** undefined / 'local' = this machine; otherwise a resolvable host alias. */
  host?: string;
}

/** Outcome of opening one surface. Never throws for launch failures — reports them. */
export interface LaunchResult {
  ok: boolean;
  request: LaunchRequest;
  error?: string;
}

/**
 * A terminal backend: pure builders + an availability check. No side effects —
 * building a spec never opens anything, so every backend is unit-testable
 * without a display. The engine's transport is what actually runs the spec.
 */
export interface TerminalBackend {
  readonly id: Backend;
  readonly label: string;
  /** Can this backend be driven here? (platform + app installed / inside tmux). */
  isAvailable(ctx: EngineContext): boolean;
  /** Command that opens a new tab running `command` in `cwd`. */
  buildTab(cwd: string, command: string[]): LaunchSpec;
  /** Command that splits the current surface, running `command` in `cwd`. */
  buildSplit(cwd: string, command: string[], direction: SplitDirection): LaunchSpec;
}
