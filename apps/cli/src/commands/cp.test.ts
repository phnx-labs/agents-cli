import { describe, it, expect } from 'vitest';
import { parseEndpoint, expandRemoteHomePrefix, resolveRemotePath, buildScpArgv } from './cp.js';
import { SSH_OPTS } from '../lib/ssh-exec.js';

// ---------------------------------------------------------------------------
// parseEndpoint
// ---------------------------------------------------------------------------

describe('parseEndpoint', () => {
  it('parses host:path as remote', () => {
    const ep = parseEndpoint('mac-mini:/abs/data.json');
    expect(ep.isRemote).toBe(true);
    if (ep.isRemote) {
      expect(ep.host).toBe('mac-mini');
      expect(ep.path).toBe('/abs/data.json');
    }
  });

  it('parses user@host:path as remote', () => {
    const ep = parseEndpoint('muqsit@yosemite-s0:/abs/src');
    expect(ep.isRemote).toBe(true);
    if (ep.isRemote) {
      expect(ep.host).toBe('muqsit@yosemite-s0');
      expect(ep.path).toBe('/abs/src');
    }
  });

  it('parses absolute local path as local', () => {
    const ep = parseEndpoint('/tmp/output.log');
    expect(ep.isRemote).toBe(false);
    if (!ep.isRemote) {
      expect(ep.path).toBe('/tmp/output.log');
    }
  });

  it('parses bare / as local', () => {
    const ep = parseEndpoint('/');
    expect(ep.isRemote).toBe(false);
  });

  it('treats a single-uppercase-letter token before colon as local (Windows drive letter)', () => {
    const ep = parseEndpoint('C:/Windows/System32');
    expect(ep.isRemote).toBe(false);
  });

  it('treats a token starting with / as local even if it contains a colon', () => {
    const ep = parseEndpoint('/usr/share/doc/pkg:1.0');
    expect(ep.isRemote).toBe(false);
  });

  it('parses host:path where path contains spaces', () => {
    const ep = parseEndpoint('mac-mini:/home/user/my files/report.pdf');
    expect(ep.isRemote).toBe(true);
    if (ep.isRemote) {
      expect(ep.path).toBe('/home/user/my files/report.pdf');
    }
  });

  it('parses host:~/path as remote with tilde in path', () => {
    const ep = parseEndpoint('yosemite-s0:~/logs/run.log');
    expect(ep.isRemote).toBe(true);
    if (ep.isRemote) {
      expect(ep.host).toBe('yosemite-s0');
      expect(ep.path).toBe('~/logs/run.log');
    }
  });

  it('parses host:$HOME/path as remote with $HOME in path', () => {
    const ep = parseEndpoint('yosemite-s0:$HOME/logs/run.log');
    expect(ep.isRemote).toBe(true);
    if (ep.isRemote) {
      expect(ep.path).toBe('$HOME/logs/run.log');
    }
  });
});

// ---------------------------------------------------------------------------
// expandRemoteHomePrefix / resolveRemotePath — core safeguard against local
// $HOME expansion. Pure expansion is unit-tested; absolute paths exercise
// resolveRemotePath without an SSH round-trip.
// ---------------------------------------------------------------------------

describe('expandRemoteHomePrefix', () => {
  const remoteHome = '/home/remote-user';

  it('expands ~ to remote HOME', () => {
    expect(expandRemoteHomePrefix('~', remoteHome)).toBe('/home/remote-user');
  });

  it('expands ~/subpath to remote HOME + /subpath', () => {
    expect(expandRemoteHomePrefix('~/logs/run.log', remoteHome)).toBe(
      '/home/remote-user/logs/run.log',
    );
  });

  it('expands $HOME to remote HOME', () => {
    expect(expandRemoteHomePrefix('$HOME', remoteHome)).toBe('/home/remote-user');
  });

  it('expands $HOME/subpath to remote HOME + /subpath', () => {
    expect(expandRemoteHomePrefix('$HOME/logs/run.log', remoteHome)).toBe(
      '/home/remote-user/logs/run.log',
    );
  });

  it('returns absolute paths unchanged', () => {
    expect(expandRemoteHomePrefix('/abs/path/file.txt', remoteHome)).toBe(
      '/abs/path/file.txt',
    );
  });

  it('never expands local $HOME into the path (regression guard)', () => {
    // Critical invariant: process.env.HOME (local) must NEVER appear in a
    // resolved remote path when the raw path contained ~ or $HOME.
    const localHome = process.env.HOME ?? '/local-user-home';
    const resolved = expandRemoteHomePrefix('~/secret', remoteHome);
    expect(resolved.startsWith(localHome)).toBe(localHome === remoteHome);
    expect(resolved).toBe('/home/remote-user/secret');
    // Even if remoteHome is deliberately different from local, the result is
    // remoteHome-based.
    expect(resolved).not.toBe(`${localHome}/secret`);
  });
});

describe('resolveRemotePath', () => {
  it('returns absolute paths unchanged without SSH (no round-trip)', async () => {
    // target/extraSshArgs would only be used if ~ or $HOME needed expanding.
    await expect(
      resolveRemotePath('/abs/path/file.txt', 'unused-host', []),
    ).resolves.toBe('/abs/path/file.txt');
  });
});

// ---------------------------------------------------------------------------
// buildScpArgv
// ---------------------------------------------------------------------------

describe('buildScpArgv', () => {
  const noId: string[] = [];
  const withId = ['-i', '/home/user/.ssh/id_fleet', '-o', 'IdentitiesOnly=yes'];

  it('produces local-to-remote args', () => {
    const argv = buildScpArgv({
      srcSpec: '/tmp/file.tar.gz',
      dstSpec: 'user@mac-mini:/abs/deploy/',
      identityArgs: noId,
      recursive: false,
    });
    expect(argv).toEqual([...SSH_OPTS, '/tmp/file.tar.gz', 'user@mac-mini:/abs/deploy/']);
  });

  it('produces remote-to-local args', () => {
    const argv = buildScpArgv({
      srcSpec: 'user@yosemite-s0:/abs/data.json',
      dstSpec: '/tmp/',
      identityArgs: noId,
      recursive: false,
    });
    expect(argv).toEqual([...SSH_OPTS, 'user@yosemite-s0:/abs/data.json', '/tmp/']);
  });

  it('includes -r when recursive', () => {
    const argv = buildScpArgv({
      srcSpec: '/tmp/src/',
      dstSpec: 'user@mac-mini:/abs/dst/',
      identityArgs: noId,
      recursive: true,
    });
    expect(argv).toContain('-r');
  });

  it('adds -3 for two-remote transfers', () => {
    const argv = buildScpArgv({
      srcSpec: 'user@yosemite-s0:/abs/a',
      dstSpec: 'user@mac-mini:/abs/b',
      identityArgs: noId,
      recursive: false,
    });
    expect(argv).toContain('-3');
  });

  it('does NOT add -3 for local-to-remote', () => {
    const argv = buildScpArgv({
      srcSpec: '/tmp/file',
      dstSpec: 'user@mac-mini:/abs/dst',
      identityArgs: noId,
      recursive: false,
    });
    expect(argv).not.toContain('-3');
  });

  it('includes identity args', () => {
    const argv = buildScpArgv({
      srcSpec: '/tmp/file',
      dstSpec: 'user@mac-mini:/abs/dst',
      identityArgs: withId,
      recursive: false,
    });
    expect(argv).toContain('-i');
    expect(argv).toContain('/home/user/.ssh/id_fleet');
  });

  it('does not inject shell metacharacters — spec contains spaces literally', () => {
    // Paths with spaces are passed as distinct argv elements, never concatenated
    // into a shell string — scp receives them literally.
    const srcSpec = '/tmp/my file with spaces.tar.gz';
    const dstSpec = 'user@mac-mini:/abs/deploy dir/';
    const argv = buildScpArgv({ srcSpec, dstSpec, identityArgs: noId, recursive: false });
    // The last two elements must be the literal src and dst, not shell-split.
    expect(argv[argv.length - 2]).toBe(srcSpec);
    expect(argv[argv.length - 1]).toBe(dstSpec);
    // No shell operators or quotes appear in any element.
    const joined = argv.join(' ');
    expect(joined).not.toContain("'");
    expect(joined).not.toContain('"');
    expect(joined).not.toContain('$');
    expect(joined).not.toContain(';');
  });
});
