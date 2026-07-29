/**
 * Open a URL in the user's default browser, cross-platform. Best-effort and
 * detached — never throws and never blocks the caller. Shared by `agents lease`
 * (Hetzner console) and `agents fleet login` (the local login dashboard).
 */
import { spawn } from 'child_process';

/** Best-effort: open a URL in the user's default browser. Never throws. */
export function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {
    /* best-effort */
  }
}
