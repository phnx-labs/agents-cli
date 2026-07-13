/**
 * Remote shell selection for Factory device dispatch (RUSH-1481).
 * Mirrors agents-cli remoteShellFor / PowerShell -EncodedCommand.
 */

/** True when the device platform string is Windows. */
export function isWindowsDevicePlatform(platform: string | undefined): boolean {
  return /^win/i.test((platform ?? '').trim());
}

/** PowerShell -EncodedCommand payload (UTF-16LE base64). */
export function encodePowershellScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Shell-quote for bash -lc outer payload (single-quote style). */
export function bashOuterQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the remote command string passed after `ssh -- <target>`.
 * Windows → powershell -EncodedCommand; otherwise bash -lc.
 */
export function buildDeviceDispatchRemoteCmd(remoteSnippet: string, platform?: string): string {
  if (isWindowsDevicePlatform(platform)) {
    return `powershell -NoProfile -EncodedCommand ${encodePowershellScript(remoteSnippet)}`;
  }
  return `bash -lc ${bashOuterQuote(remoteSnippet)}`;
}
