import { describe, expect, it } from 'vitest';
import {
  parseConfigKey,
  formatConfigKey,
  devicePropertyToConfigName,
  listKnownConfigKeys,
  configKeyStorageHint,
} from './config-keys.js';

describe('config-keys', () => {
  describe('parseConfigKey', () => {
    it('parses run model key with wildcard version', () => {
      const parsed = parseConfigKey('run.claude@*.model');
      expect(parsed).toEqual({ scope: 'run', agent: 'claude', version: '*', property: 'model' });
    });

    it('parses run model key with concrete version', () => {
      const parsed = parseConfigKey('run.claude@2.1.45.model');
      expect(parsed).toEqual({ scope: 'run', agent: 'claude', version: '2.1.45', property: 'model' });
    });

    it('parses run mode and effort keys', () => {
      expect(parseConfigKey('run.codex@0.134.0.mode')).toEqual({
        scope: 'run',
        agent: 'codex',
        version: '0.134.0',
        property: 'mode',
      });
      expect(parseConfigKey('run.grok@*.effort')).toEqual({
        scope: 'run',
        agent: 'grok',
        version: '*',
        property: 'effort',
      });
    });

    it('parses run tier key', () => {
      expect(parseConfigKey('run.claude@*.tier.best')).toEqual({
        scope: 'run',
        agent: 'claude',
        version: '*',
        property: 'tier',
        tier: 'best',
      });
    });

    it('accepts colon as agent/version separator', () => {
      const parsed = parseConfigKey('run.claude:2.1.45.model');
      expect(parsed).toEqual({ scope: 'run', agent: 'claude', version: '2.1.45', property: 'model' });
    });

    it('parses interactive host', () => {
      expect(parseConfigKey('interactive.host')).toEqual({ scope: 'interactive', property: 'host' });
    });

    it('parses usage primary host', () => {
      expect(parseConfigKey('usage.primary-host')).toEqual({ scope: 'usage', property: 'primary-host' });
    });

    it('parses browser profile', () => {
      expect(parseConfigKey('browser.profile')).toEqual({ scope: 'browser', property: 'profile' });
    });

    it('parses device config keys', () => {
      expect(parseConfigKey('devices.mac-mini.max-agents')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'max-agents',
      });
      expect(parseConfigKey('devices.mac-mini.scheduler')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'scheduler',
      });
      expect(parseConfigKey('devices.mac-mini.browser.remote-control')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'browser.remote-control',
      });
      expect(parseConfigKey('devices.mac-mini.browser.profile')).toEqual({
        scope: 'device',
        device: 'mac-mini',
        property: 'browser.profile',
      });
    });

    it('rejects unknown agent', () => {
      expect(() => parseConfigKey('run.notanagent@*.model')).toThrow(/Unknown agent/);
    });

    it('rejects invalid version', () => {
      expect(() => parseConfigKey('run.claude@bad..version.model')).toThrow(/Invalid version/);
    });

    it('rejects invalid run property', () => {
      expect(() => parseConfigKey('run.claude@*.foo')).toThrow(/Invalid run config key/);
    });

    it('rejects invalid tier', () => {
      expect(() => parseConfigKey('run.claude@*.tier.extreme')).toThrow(/Invalid run config key/);
    });

    it('rejects unknown scope', () => {
      expect(() => parseConfigKey('foo.bar')).toThrow(/Unknown config scope/);
    });

    it('rejects incomplete device key', () => {
      expect(() => parseConfigKey('devices.mac-mini')).toThrow(/Invalid device config key/);
    });

    it('rejects unknown device property', () => {
      expect(() => parseConfigKey('devices.mac-mini.unknown')).toThrow(/Invalid device config key/);
    });
  });

  describe('formatConfigKey', () => {
    it('round-trips parsed keys', () => {
      for (const key of [
        'run.claude@*.model',
        'run.claude@2.1.45.tier.best',
        'interactive.host',
        'usage.primary-host',
        'browser.profile',
        'devices.mac-mini.max-agents',
      ]) {
        expect(formatConfigKey(parseConfigKey(key))).toBe(key);
      }
    });
  });

  describe('devicePropertyToConfigName', () => {
    it('maps friendly names to internal config keys', () => {
      expect(devicePropertyToConfigName('max-agents')).toBe('agents.max-concurrent');
      expect(devicePropertyToConfigName('scheduler')).toBe('scheduler.enabled');
      expect(devicePropertyToConfigName('daemon')).toBe('daemon.enabled');
      expect(devicePropertyToConfigName('watchdog')).toBe('watchdog.enabled');
      expect(devicePropertyToConfigName('browser.remote-control')).toBe('browser.remote-control');
      expect(devicePropertyToConfigName('notes')).toBe('notes');
      expect(devicePropertyToConfigName('browser.profile')).toBe('browser.profile');
    });
  });

  describe('listKnownConfigKeys', () => {
    it('includes run, interactive, browser, and device keys', () => {
      const keys = listKnownConfigKeys();
      expect(keys).toContain('run.<agent@version>.model');
      expect(keys).toContain('run.<agent@version>.tier.best');
      expect(keys).toContain('interactive.host');
      expect(keys).toContain('usage.primary-host');
      expect(keys).toContain('browser.profile');
      expect(keys).toContain('devices.<name>.max-agents');
    });
  });

  describe('configKeyStorageHint', () => {
    it('describes where run keys are stored', () => {
      expect(configKeyStorageHint(parseConfigKey('run.claude@*.model'))).toBe(
        'run.defaults.claude:*.model',
      );
      expect(configKeyStorageHint(parseConfigKey('run.claude@*.tier.best'))).toBe(
        'model.tiers.claude:*.best',
      );
    });

    it('describes where the usage primary host is stored', () => {
      expect(configKeyStorageHint(parseConfigKey('usage.primary-host'))).toBe(
        'config.usagePrimaryHost',
      );
    });
  });
});
