/**
 * Terminal launch engine — open an interactive command as a tab or split pane
 * in iTerm / Ghostty / tmux, on this machine or a remote host.
 *
 * Public entry point. Callers typically use `openSurfaces` (a batch with a
 * layout policy) or `openSurface` (a single request), and `availableBackends` /
 * `detectCurrentBackend` to pick a target. See docs/terminal-engine.md.
 */
export type {
  Backend,
  SplitDirection,
  Layout,
  EngineContext,
  LaunchSpec,
  LaunchRequest,
  LaunchResult,
  TerminalBackend,
} from './types.js';
export { currentContext } from './types.js';

export { BACKENDS, detectCurrentBackend, availableBackends, itermBackend, ghosttyBackend, tmuxBackend } from './backends/index.js';
export { planLayouts, type Packing } from './policy.js';
export {
  specForRequest,
  buildRequests,
  openSurface,
  openSurfaces,
  type OpenOptions,
  type OpenManyOptions,
  type BuildRequestsOptions,
  type SurfaceItem,
} from './engine.js';
export { runLocal, runRemote, runSpec, remoteCommand, type HostResolver, type RunResult } from './transport.js';
export {
  injectIntoTerminal,
  tmuxSendKeysArgv,
  tmuxInjectSpecs,
  itermInjectScript,
  ghosttyInjectScript,
  appleScriptInjectSpec,
  vscodiumInjectUri,
  vscodiumInjectSpec,
  type InjectTarget,
  type InjectBackend,
  type InjectOptions,
  type InjectResult,
} from './inject.js';
export {
  resolveInjectTarget,
  resolveInjectTargetForSession,
  type InjectResolution,
  type InjectRail,
  type ResolveOptions,
} from './resolve.js';
