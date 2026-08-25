import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './claude.js';
import type { ExecConfigEnvCtx } from '../adapter.js';
import type { ConfiguredDeviceRole } from '../../device-config.js';

/**
 * The credential decision in `claudeAdapter.applyExecConfigEnv` — which account a
 * Claude run authenticates as — is a function of DEVICE ROLE and run mode, not
 * run mode alone (RUSH-2395). This exercises the whole matrix directly against
 * the adapter (no config/keychain), because getting it wrong silently reroutes a
 * run onto the wrong account: a headless run on the user's laptop hijacking their
 * login, or a worker run failing to pick up its setup-token.
 */
describe('claudeAdapter.applyExecConfigEnv — role-aware CLAUDE_CODE_OAUTH_TOKEN', () => {
  const VERSION_HOME = '/tmp/rush-2395-version-home';
  const OWN_TOKEN = 'sk-ant-oat01-own-account';
  const FOREIGN_TOKEN = 'sk-ant-oat01-someone-else';

  /**
   * Run the adapter with a stubbed setup-token resolver and return the token the
   * run would end up authenticating with (undefined = defers to the per-version
   * login). `ambient` seeds an already-present CLAUDE_CODE_OAUTH_TOKEN, standing
   * in for a value inherited from a parent shell (sanitizeProcessEnv keeps it).
   */
  function resolvedToken(opts: {
    interactive: boolean;
    deviceRole?: ConfiguredDeviceRole;
    setupToken: string | null;
    ambient?: string;
  }): string | undefined {
    const result: NodeJS.ProcessEnv = {};
    if (opts.ambient !== undefined) result.CLAUDE_CODE_OAUTH_TOKEN = opts.ambient;
    const ctx: ExecConfigEnvCtx = {
      agent: 'claude',
      version: 'test',
      versionHome: VERSION_HOME,
      interactive: opts.interactive,
      deviceRole: opts.deviceRole,
      resolveClaudeSetupToken: () => opts.setupToken,
    };
    claudeAdapter.applyExecConfigEnv!(result, ctx);
    return result.CLAUDE_CODE_OAUTH_TOKEN;
  }

  describe('worker device (or unmarked) — headless runs use the setup-token', () => {
    it('injects the per-account setup-token on a headless worker run', () => {
      expect(resolvedToken({ interactive: false, deviceRole: 'worker', setupToken: OWN_TOKEN }))
        .toBe(OWN_TOKEN);
    });

    it('the setup-token wins over an ambient inherited value (worker headless)', () => {
      expect(resolvedToken({
        interactive: false,
        deviceRole: 'worker',
        setupToken: OWN_TOKEN,
        ambient: 'sk-ant-oat01-shared-must-not-win',
      })).toBe(OWN_TOKEN);
    });

    it('strips an ambient token when NO setup-token resolves (provisioned-box leak)', () => {
      expect(resolvedToken({
        interactive: false,
        deviceRole: 'worker',
        setupToken: null,
        ambient: 'sk-ant-oat01-shared-rotating',
      })).toBeUndefined();
    });

    it('treats an UNMARKED device (undefined role) as a worker — still injects on headless', () => {
      expect(resolvedToken({ interactive: false, deviceRole: undefined, setupToken: OWN_TOKEN }))
        .toBe(OWN_TOKEN);
    });
  });

  describe('personal device — every run defers to the per-version login', () => {
    it('a HEADLESS run on a personal box does NOT inject the setup-token (the RUSH-2395 fix)', () => {
      // `agents run claude "fix the bug"` on the laptop: prompt present -> headless,
      // but role personal -> must stay on the login, not the setup-token.
      expect(resolvedToken({ interactive: false, deviceRole: 'personal', setupToken: OWN_TOKEN }))
        .toBeUndefined();
    });

    it('strips an inherited copy of OUR OWN setup-token so the login wins (headless personal)', () => {
      expect(resolvedToken({
        interactive: false,
        deviceRole: 'personal',
        setupToken: OWN_TOKEN,
        ambient: OWN_TOKEN,
      })).toBeUndefined();
    });

    it('leaves a DIFFERENT ambient token alone — a deliberately-exported value survives (#2383)', () => {
      expect(resolvedToken({
        interactive: false,
        deviceRole: 'personal',
        setupToken: OWN_TOKEN,
        ambient: FOREIGN_TOKEN,
      })).toBe(FOREIGN_TOKEN);
    });

    it('an INTERACTIVE run on a personal box also defers to the login', () => {
      expect(resolvedToken({ interactive: true, deviceRole: 'personal', setupToken: OWN_TOKEN }))
        .toBeUndefined();
    });
  });

  describe('interactive runs defer to the login regardless of role', () => {
    it('interactive on an unmarked/worker device still leaves the login (value-match strip only)', () => {
      expect(resolvedToken({ interactive: true, deviceRole: 'worker', setupToken: OWN_TOKEN }))
        .toBeUndefined();
      expect(resolvedToken({
        interactive: true,
        deviceRole: 'worker',
        setupToken: OWN_TOKEN,
        ambient: OWN_TOKEN,
      })).toBeUndefined();
    });
  });
});
