import { describe, it, expect } from 'vitest';
import {
  isWindowsDevicePlatform,
  buildDeviceDispatchRemoteCmd,
  encodePowershellScript,
} from './deviceDispatchShell.js';

describe('deviceDispatchShell (RUSH-1481)', () => {
  it('detects windows platforms', () => {
    expect(isWindowsDevicePlatform('windows')).toBe(true);
    expect(isWindowsDevicePlatform('Windows')).toBe(true);
    expect(isWindowsDevicePlatform('win32')).toBe(true);
    expect(isWindowsDevicePlatform('macos')).toBe(false);
    expect(isWindowsDevicePlatform(undefined)).toBe(false);
  });

  it('uses bash -lc for POSIX platforms', () => {
    const cmd = buildDeviceDispatchRemoteCmd('agents run claude hi', 'macos');
    expect(cmd.startsWith('bash -lc ')).toBe(true);
    expect(cmd).toContain('agents run claude hi');
    expect(cmd).not.toContain('powershell');
  });

  it('uses powershell EncodedCommand for windows', () => {
    const snippet = 'Write-Host hello';
    const cmd = buildDeviceDispatchRemoteCmd(snippet, 'windows');
    expect(cmd.startsWith('powershell -NoProfile -EncodedCommand ')).toBe(true);
    expect(cmd).not.toContain('bash -lc');
    const b64 = cmd.split(' ').pop()!;
    expect(b64).toBe(encodePowershellScript(snippet));
  });
});
