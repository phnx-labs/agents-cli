// Pure, vscode-free predicates that gate what a webview message is allowed to
// make the extension host do. Webview messages are untrusted input — if the
// React UI is ever injected with hostile content (an XSS, a crafted PR title,
// an agent-supplied path), these allowlists are what stop a single message from
// opening a `file:`/`command:` URL or running an arbitrary VS Code command.
// Kept here (not in src/vscode) so they can be unit-tested without a VS Code
// host.

// Schemes a webview is permitted to open externally. Anything else — `file:`,
// `command:`, `vscode:`, `javascript:`, `data:` — is refused.
const ALLOWED_EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

// True only if `rawUrl` is a non-empty string that parses to an allowed scheme.
export function isAllowedExternalUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let scheme: string;
  try {
    scheme = new URL(rawUrl).protocol.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_EXTERNAL_SCHEMES.has(scheme);
}

// The dashboard webview only ever dispatches a fixed set of commands: the
// light/dark theme toggle and the `agents.new*` agent-spawn commands. Gate the
// generic `executeCommand` message to that set so an injected message cannot
// run an arbitrary VS Code command (which would include shell-spawning ones).
export function isAllowedWebviewCommand(command: string): boolean {
  return command === 'workbench.action.toggleLightDarkThemes' || command.startsWith('agents.new');
}
