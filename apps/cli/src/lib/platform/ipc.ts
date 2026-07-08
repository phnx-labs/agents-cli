/**
 * Local-daemon IPC endpoint, platform-aware.
 */
import * as crypto from 'crypto';

/**
 * Resolve the address a local daemon listens on / clients connect to.
 *
 * POSIX: the AF_UNIX socket file path itself.
 * Windows: a named pipe (`\\.\pipe\agents-<hash>`). Filesystem socket files
 * aren't supported there, and named pipes are NOT filesystem objects — derive a
 * stable name from a hash of the socket path so client and server agree without
 * touching disk, and never probe the result with fs.existsSync (it always reports
 * false). Both forms are accepted by net.createServer / net.createConnection.
 */
export function ipcEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const hash = crypto.createHash('sha1').update(socketPath).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\agents-${hash}`;
  }
  return socketPath;
}
