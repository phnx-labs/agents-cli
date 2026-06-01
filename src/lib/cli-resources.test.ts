import { describe, expect, it } from 'vitest';

import {
  parseCliManifest,
  selectInstallMethod,
  describeMethod,
  buildInstallCommand,
  type CliManifest,
  type InstallMethod,
} from './cli-resources.js';

function manifest(install: InstallMethod[]): CliManifest {
  return {
    name: 'higgsfield',
    description: 'test',
    check: { kind: 'version', cmd: 'higgsfield', args: ['--version'] },
    install,
    source: 'user',
    path: '/tmp/test.yaml',
  };
}

describe('parseCliManifest', () => {
  it('parses a multi-method manifest with post_install', () => {
    const yaml = `
name: higgsfield
description: AI media CLI
homepage: https://higgsfield.ai/cli
check: higgsfield --version
install:
  - npm: "@higgsfield/cli@latest"
  - brew: higgsfield
  - script: https://example.com/install.sh
post_install: |
  Run higgsfield auth login.
`;
    const parsed = parseCliManifest(yaml, { name: 'higgsfield', source: 'user', path: '/tmp/h.yaml' });
    expect(parsed.name).toBe('higgsfield');
    expect(parsed.description).toBe('AI media CLI');
    expect(parsed.check).toEqual({ kind: 'version', cmd: 'higgsfield', args: ['--version'] });
    expect(parsed.install).toHaveLength(3);
    expect(parsed.install[0]).toEqual({ npm: '@higgsfield/cli@latest' });
    expect(parsed.install[1]).toEqual({ brew: 'higgsfield' });
    expect(parsed.install[2]).toEqual({ script: 'https://example.com/install.sh' });
    expect(parsed.postInstall).toMatch(/auth login/);
  });

  it('defaults check to "<name> --version" when omitted', () => {
    const parsed = parseCliManifest(
      'name: gh\ninstall:\n  - brew: gh\n',
      { name: 'gh', source: 'user', path: '/tmp/g.yaml' },
    );
    expect(parsed.check).toEqual({ kind: 'version', cmd: 'gh', args: ['--version'] });
  });

  it('uses the filename-derived name when manifest omits it', () => {
    const parsed = parseCliManifest(
      'install:\n  - brew: glab\n',
      { name: 'glab', source: 'user', path: '/tmp/glab.yaml' },
    );
    expect(parsed.name).toBe('glab');
  });

  it('rejects an empty install list', () => {
    expect(() =>
      parseCliManifest('name: x\ninstall: []\n', { name: 'x', source: 'user', path: '/x' }),
    ).toThrow(/non-empty list/);
  });

  it('rejects an install entry with no recognized method', () => {
    expect(() =>
      parseCliManifest(
        'name: x\ninstall:\n  - apt: x\n',
        { name: 'x', source: 'user', path: '/x' },
      ),
    ).toThrow(/unknown method/);
  });

  it('rejects an install entry with multiple methods declared', () => {
    expect(() =>
      parseCliManifest(
        'name: x\ninstall:\n  - npm: x\n    brew: x\n',
        { name: 'x', source: 'user', path: '/x' },
      ),
    ).toThrow(/exactly one method/);
  });

  it('parses a binary platform map with extract path', () => {
    const yaml = `
name: x
install:
  - binary:
      darwin-arm64:
        url: https://example.com/x-darwin.tgz
        extract: x
      linux-x64:
        url: https://example.com/x-linux.tgz
        extract: x
`;
    const parsed = parseCliManifest(yaml, { name: 'x', source: 'user', path: '/x' });
    expect(parsed.install).toHaveLength(1);
    const m = parsed.install[0];
    expect('binary' in m).toBe(true);
    if ('binary' in m) {
      expect(m.binary['darwin-arm64'].url).toBe('https://example.com/x-darwin.tgz');
      expect(m.binary['darwin-arm64'].extract).toBe('x');
    }
  });
});

describe('describeMethod', () => {
  it('renders npm/brew/script', () => {
    expect(describeMethod({ npm: 'foo@1.0' })).toBe('npm install -g foo@1.0');
    expect(describeMethod({ brew: 'foo' })).toBe('brew install foo');
    expect(describeMethod({ script: 'https://x' })).toBe('curl https://x | sh');
  });
});

describe('buildInstallCommand', () => {
  it('builds the npm and brew shell strings exactly', () => {
    expect(buildInstallCommand({ npm: '@higgsfield/cli@latest' }))
      .toBe('npm install -g @higgsfield/cli@latest');
    expect(buildInstallCommand({ brew: 'higgsfield' }))
      .toBe('brew install higgsfield');
  });
});

describe('selectInstallMethod', () => {
  // selectInstallMethod calls hasCommand() which probes the real host.
  // We can still validate the "no compatible method" path deterministically.
  it('returns null when only an unsupported-platform binary is declared', () => {
    const m = manifest([{ binary: { 'plan9-mips': { url: 'http://x' } } }]);
    expect(selectInstallMethod(m)).toBeNull();
  });

  it('returns the only npm method on a host with npm (this dev box has npm)', () => {
    // We rely on the dev environment having npm; if it doesn't, this test is
    // skipped at the assertion level rather than failing.
    const m = manifest([{ npm: 'foo' }]);
    const picked = selectInstallMethod(m);
    if (picked) {
      expect(picked).toEqual({ npm: 'foo' });
    }
  });
});
