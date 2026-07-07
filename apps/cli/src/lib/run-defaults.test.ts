import { describe, expect, it } from 'vitest';
import {
  normalizeRunDefaultMode,
  parseRunDefaultSelector,
  resolveRunDefaultsFromConfig,
  resolveRunDefaultsFromConfigs,
} from './run-defaults.js';
import type { RunConfig } from './types.js';

describe('run defaults', () => {
  it('canonicalizes selector forms', () => {
    expect(parseRunDefaultSelector('claude:*')).toEqual({
      agent: 'claude',
      version: '*',
      selector: 'claude:*',
    });
    expect(parseRunDefaultSelector('claude@2.1.45')).toEqual({
      agent: 'claude',
      version: '2.1.45',
      selector: 'claude:2.1.45',
    });
    expect(parseRunDefaultSelector('codex')).toEqual({
      agent: 'codex',
      version: '*',
      selector: 'codex:*',
    });
  });

  it('rejects invalid selectors', () => {
    expect(() => parseRunDefaultSelector('unknown:*')).toThrow(/Invalid agent/);
    expect(() => parseRunDefaultSelector('claude:../../bad')).toThrow(/Invalid selector version/);
    expect(() => parseRunDefaultSelector('claude@1@2')).toThrow(/Invalid selector/);
  });

  it("normalizes legacy 'full' mode to skip", () => {
    expect(normalizeRunDefaultMode('full')).toBe('skip');
    expect(normalizeRunDefaultMode('AUTO')).toBe('auto');
    expect(() => normalizeRunDefaultMode('write')).toThrow(/Invalid mode/);
  });

  it('merges wildcard and exact selector defaults field by field', () => {
    const config: RunConfig = {
      defaults: {
        'claude:*': {
          mode: 'auto',
          model: 'opus',
        },
        'claude:2.1.45': {
          mode: 'plan',
        },
      },
    };

    expect(resolveRunDefaultsFromConfig(config, 'claude', '2.1.45')).toEqual({
      mode: 'plan',
      model: 'opus',
      sources: {
        mode: 'claude:2.1.45',
        model: 'claude:*',
      },
    });
  });

  it('uses wildcard defaults when no exact selector matches', () => {
    const config: RunConfig = {
      defaults: {
        'codex:*': {
          mode: 'plan',
          model: 'gpt-5.2-codex',
        },
      },
    };

    expect(resolveRunDefaultsFromConfig(config, 'codex', '0.134.0')).toEqual({
      mode: 'plan',
      model: 'gpt-5.2-codex',
      sources: {
        mode: 'codex:*',
        model: 'codex:*',
      },
    });
  });

  it('layers multiple configs field by field with later configs taking precedence', () => {
    const userConfig: RunConfig = {
      defaults: {
        'claude:*': {
          mode: 'auto',
          model: 'opus',
        },
      },
    };
    const projectConfig: RunConfig = {
      defaults: {
        'claude:2.1.45': {
          mode: 'plan',
        },
      },
    };

    expect(resolveRunDefaultsFromConfigs([userConfig, projectConfig], 'claude', '2.1.45')).toEqual({
      mode: 'plan',
      model: 'opus',
      sources: {
        mode: 'claude:2.1.45',
        model: 'claude:*',
      },
    });
  });
});
