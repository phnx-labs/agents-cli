import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectAgentsBinaryShadows } from './binary-shadow.js';

describe('detectAgentsBinaryShadows', () => {
  const savedPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = savedPath ?? '';
  });

  function withSystemPath(tmpDir: string): string {
    // Keep the system `which` binary available.
    return `${tmpDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  }

  it('returns empty when only the current agents binary exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shadow-one-'));
    const agents = path.join(tmpDir, 'agents');
    fs.writeFileSync(agents, '#!/bin/sh\necho current\n', { mode: 0o755 });
    process.env.PATH = withSystemPath(tmpDir);
    try {
      expect(detectAgentsBinaryShadows(agents, [])).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects a shadowing binary earlier on PATH', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shadow-path-'));
    const realAgents = path.join(tmpDir, 'real-agents');
    const shadowAgents = path.join(tmpDir, 'agents');
    fs.writeFileSync(realAgents, '#!/bin/sh\necho real\n', { mode: 0o755 });
    fs.writeFileSync(shadowAgents, '#!/bin/sh\necho shadow\n', { mode: 0o755 });
    process.env.PATH = withSystemPath(tmpDir);
    try {
      const shadows = detectAgentsBinaryShadows(realAgents, []);
      expect(shadows).toHaveLength(1);
      expect(shadows[0].path).toBe(shadowAgents);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects a latent shadow in a well-known install directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shadow-wellknown-'));
    const realAgents = path.join(tmpDir, 'agents');
    const shadowDir = path.join(tmpDir, 'extra-bin');
    const shadowAgents = path.join(shadowDir, 'agents');
    fs.writeFileSync(realAgents, '#!/bin/sh\necho real\n', { mode: 0o755 });
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(shadowAgents, '#!/bin/sh\necho shadow\n', { mode: 0o755 });
    process.env.PATH = withSystemPath(tmpDir);
    try {
      const shadows = detectAgentsBinaryShadows(realAgents, [shadowDir]);
      expect(shadows.some((s) => s.path === shadowAgents)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
