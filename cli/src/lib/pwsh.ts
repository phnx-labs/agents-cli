/**
 * PowerShell `-EncodedCommand` helper.
 *
 * Base64 of a script's UTF-16LE bytes is a single quote-free token, so it rides
 * through Node spawn → Windows sshd → cmd.exe with zero escaping hazards
 * (hand-quoted `powershell -Command "…"` is fragile the moment a path, URL, or
 * newline is involved). Shared by the browser SSH driver (which builds a
 * `powershell -EncodedCommand …` string) and the Windows secrets backend (which
 * spawns powershell.exe with an argv array).
 */
export function encodePwshBase64(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
