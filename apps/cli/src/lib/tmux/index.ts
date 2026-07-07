/**
 * Public entry-point for the tmux integration. Consumers outside the CLI
 * (swarmify extension, `agents teams` multiplexer mode, future MCP wrapper)
 * should import from here.
 */

export {
  findTmuxBinary,
  isTmuxInstalled,
  getTmuxVersion,
  assertTmuxAvailable,
  TmuxUnavailableError,
  TmuxCommandError,
  runTmux,
  attachTmux,
} from './binary.js';

export {
  getDefaultSocketPath,
  getSessionMetaPath,
  ensureTmuxDir,
} from './paths.js';

export {
  assertValidSessionName,
  slugifyName,
  hasSession,
  createSession,
  killSession,
  killAll,
  listSessions,
  splitPane,
  sendKeys,
  capturePane,
  readSessionMeta,
  TmuxSessionError,
  type SessionMeta,
  type CreateSessionOptions,
  type ListedSession,
  type SplitOptions,
  type SendOptions,
  type CaptureOptions,
} from './session.js';
