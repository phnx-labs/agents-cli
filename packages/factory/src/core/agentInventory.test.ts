import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  normalizeRunStrategy,
  readAgentRunStrategy,
  readAgentRunStrategyFromConfig,
  setAgentRunStrategyInConfig,
  summarizeAgentInventory,
  writeAgentRunStrategy,
} from './agentInventory';

const FIXTURE_PATH = path.join(__dirname, 'testdata', 'view-claude.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

describe('agentInventory', () => {
  test('normalizes run strategy safely', () => {
    expect(normalizeRunStrategy('balanced')).toBe('balanced');
    expect(normalizeRunStrategy('available')).toBe('available');
    expect(normalizeRunStrategy('pinned')).toBe('pinned');
    expect(normalizeRunStrategy('bogus')).toBe('pinned');
    expect(normalizeRunStrategy(undefined)).toBe('pinned');
  });

  test('aliases legacy "rotate" to "balanced"', () => {
    expect(normalizeRunStrategy('rotate')).toBe('balanced');
    expect(readAgentRunStrategyFromConfig({ run: { claude: { strategy: 'rotate' } } }, 'claude')).toBe('balanced');
  });

  test('reads run strategy from config', () => {
    expect(readAgentRunStrategyFromConfig({ run: { claude: { strategy: 'available' } } }, 'claude')).toBe('available');
    expect(readAgentRunStrategyFromConfig({ run: { claude: { strategy: 'bogus' } } }, 'claude')).toBe('pinned');
  });

  test('writes run strategy into config without clobbering siblings', () => {
    const next = setAgentRunStrategyInConfig({ defaults: { method: 'symlink' } }, 'claude', 'balanced');
    expect(next.defaults).toEqual({ method: 'symlink' });
    expect(readAgentRunStrategyFromConfig(next, 'claude')).toBe('balanced');
  });

  test('summarizes agent inventory from agents view json', () => {
    const summary = summarizeAgentInventory('claude', fixture, 'balanced');
    expect(summary.agent).toBe('claude');
    expect(summary.strategy).toBe('balanced');
    expect(summary.defaultVersion).toBe('2.1.112');
    expect(summary.defaultAccount).toBe('muqsitnawaz@gmail.com');
    expect(summary.signedInCount).toBeGreaterThan(1);
    expect(summary.canRotate).toBe(true);
    expect(summary.versions[0].sessionUsedPercent).toBe(19);
  });

  test('writes available strategy without losing siblings', () => {
    const next = setAgentRunStrategyInConfig({ run: { codex: { strategy: 'balanced' } } }, 'claude', 'available');
    expect(readAgentRunStrategyFromConfig(next, 'claude')).toBe('available');
    expect(readAgentRunStrategyFromConfig(next, 'codex')).toBe('balanced');
  });

  test('round-trips all three strategies through the on-disk yaml config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inv-'));
    const configPath = path.join(dir, 'agents.yaml');
    try {
      writeAgentRunStrategy('claude', 'available', configPath);
      expect(readAgentRunStrategy('claude', configPath)).toBe('available');
      writeAgentRunStrategy('claude', 'balanced', configPath);
      expect(readAgentRunStrategy('claude', configPath)).toBe('balanced');
      writeAgentRunStrategy('claude', 'pinned', configPath);
      expect(readAgentRunStrategy('claude', configPath)).toBe('pinned');
      writeAgentRunStrategy('codex', 'balanced', configPath);
      expect(readAgentRunStrategy('claude', configPath)).toBe('pinned');
      expect(readAgentRunStrategy('codex', configPath)).toBe('balanced');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('canRotate is false when only one version is signed in', () => {
    const oneSignedIn = {
      agent: 'claude',
      versions: [
        {
          version: '2.1.0', isDefault: true, signedIn: true,
          email: 'a@b.com', plan: 'Max', usageStatus: 'available',
          windows: [{ key: 'session', usedPercent: 0, resetsAt: null }],
          lastActive: null, path: '/tmp/x',
        },
        {
          version: '2.0.0', isDefault: false, signedIn: false,
          email: null, plan: null, usageStatus: 'available',
          windows: [], lastActive: null, path: '/tmp/y',
        },
      ],
    } as any;
    const summary = summarizeAgentInventory('claude', oneSignedIn, 'pinned');
    expect(summary.signedInCount).toBe(1);
    expect(summary.canRotate).toBe(false);
  });
});
