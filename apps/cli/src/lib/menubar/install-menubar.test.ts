import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyMenubarProcesses,
  codesignVerifies,
  ensureValidSignature,
  isMenubarStale,
  menubarPlistNeedsRepoint,
  restartMenubarLaunchAgent,
} from './install-menubar.js';

// Regression guard for the STOLEN-HOTKEY blind spot. Status used
// `pgrep -f MenubarHelper`, which matches ANY process with that name — so a
// stray dev build launched over ssh reported `running: yes` while it, not the
// installed bundle, held the global Cmd-Shift-V chord (RegisterEventHotKey is
// first-come). The paste was dead and status said everything was fine. The
// fixtures below are the real `ps -axo pid=,command=` lines from that incident.
describe('classifyMenubarProcesses', () => {
  // Note the space in "Application Support" — the reason pid/field parsing takes
  // the rest of the line rather than splitting on whitespace.
  const INSTALLED =
    '/Users/muqsit/Library/Application Support/agents-cli/MenubarHelper.app/Contents/MacOS/MenubarHelper';
  // Orphaned SwiftPM debug build from a deleted worktree, started over ssh.
  const ORPHAN =
    '/Users/muqsit/src/github.com/muqsitnawaz/agents-cli/.agents/worktrees/menubar-verify/apps/cli/menubar/.build/arm64-apple-macosx/debug/MenubarHelper';

  it('reports the installed bundle as running', () => {
    const r = classifyMenubarProcesses(`74027 ${INSTALLED}`, `74027 ${INSTALLED}`, INSTALLED);
    expect(r.running).toBe(true);
    expect(r.foreign).toEqual([]);
  });

  it('flags a stray build as foreign, not as the installed helper running', () => {
    const r = classifyMenubarProcesses(`58619 ${ORPHAN}`, `58619 .build/debug/MenubarHelper --self-test`, INSTALLED);
    expect(r.running).toBe(false);
    expect(r.foreign).toEqual([{ pid: 58619, executable: ORPHAN }]);
  });

  it('separates the two when both are alive — the state that broke the paste', () => {
    const comm = `74027 ${INSTALLED}\n58619 ${ORPHAN}`;
    const r = classifyMenubarProcesses(comm, comm, INSTALLED);
    expect(r.running).toBe(true);
    expect(r.foreign.map((p) => p.pid)).toEqual([58619]);
  });

  it('ignores --notify one-shots (installed binary, but never the status item)', () => {
    const r = classifyMenubarProcesses(
      `91002 ${INSTALLED}`,
      `91002 ${INSTALLED} --notify --title Done`,
      INSTALLED,
    );
    expect(r.running).toBe(false);
    expect(r.foreign).toEqual([]);
  });

  // The false positive that a command-line substring match produced: this
  // shell is not a helper, it merely mentions one.
  it('does not flag a shell whose command line merely mentions MenubarHelper', () => {
    const r = classifyMenubarProcesses(
      '18933 /bin/zsh',
      '18933 /bin/zsh -c cp /bin/sleep .build/debug/MenubarHelper',
      INSTALLED,
    );
    expect(r.running).toBe(false);
    expect(r.foreign).toEqual([]);
  });

  it('ignores unrelated processes', () => {
    const ps = '3675 /System/Library/.../com.apple.Passwords.MenuBarExtra\n1 /sbin/launchd';
    const r = classifyMenubarProcesses(ps, ps, INSTALLED);
    expect(r.running).toBe(false);
    expect(r.foreign).toEqual([]);
  });
});

// Regression guard for the upgrade self-heal: before this, the helper was only
// (re)installed when no service existed, so `npm update` left the menu bar
// running the previous release's binary. isMenubarStale is the decision that
// must flag an upgraded/missing install for reinstall.
describe('isMenubarStale', () => {
  it('is stale when the helper binary is gone (App Support cleared)', () => {
    expect(isMenubarStale({ installedVersion: '1.20.24', currentVersion: '1.20.24', execExists: false })).toBe(true);
  });

  it('is stale after an upgrade (installed version != current)', () => {
    expect(isMenubarStale({ installedVersion: '1.20.24', currentVersion: '1.20.25', execExists: true })).toBe(true);
  });

  it('is stale on a pre-stamp install (no version marker yet)', () => {
    expect(isMenubarStale({ installedVersion: null, currentVersion: '1.20.25', execExists: true })).toBe(true);
  });

  it('is NOT stale when version matches and the binary is present', () => {
    expect(isMenubarStale({ installedVersion: '1.20.25', currentVersion: '1.20.25', execExists: true })).toBe(false);
  });
});

// Regression guard for the DUAL-INSTALL skew: the plist was baked by one install
// (e.g. nvm) but the user's `agents` now resolves to another (e.g. bun), so the
// helper kept shelling a stale copy for menu data + the quick-issue dispatch. A
// version bump can't catch this (the copies can even be the same version), so
// the re-point keys off the plist's baked interpreter/entry vs the active one.
describe('menubarPlistNeedsRepoint', () => {
  const nvm = '/Users/me/.nvm/versions/node/v24/lib/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const bun = '/Users/me/.bun/install/global/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const nvmNode = '/Users/me/.nvm/versions/node/v24/bin/node';
  const bunNode = '/Users/me/.bun/bin/node';

  it('re-points when the plist entry differs from the active install', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: nvm, plistNode: nvmNode, activeEntry: bun, activeNode: bunNode })).toBe(true);
  });

  it('re-points when only the node interpreter drifted (same entry path)', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: bun, plistNode: nvmNode, activeEntry: bun, activeNode: bunNode })).toBe(true);
  });

  it('does NOT re-point when the plist already matches the active install', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: bun, plistNode: bunNode, activeEntry: bun, activeNode: bunNode })).toBe(false);
  });

  it('does NOT re-point (churn) when the active entry cannot be resolved (dev/tsx run)', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: bun, plistNode: bunNode, activeEntry: null, activeNode: null })).toBe(false);
  });

  it('re-points a plist that has no baked entry yet (older install)', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: null, plistNode: null, activeEntry: bun, activeNode: bunNode })).toBe(true);
  });
});

// Regression guard for the auto-heal restart sequence: without a `bootout` first,
// `bootstrap` fails on modern macOS when the job is already loaded, leaving the
// helper in a dead state after a WindowServer disconnect.
describe('restartMenubarLaunchAgent', () => {
  it('boots out the old job, bootstraps the plist, then kickstarts the service', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: args as string[] });
      return Buffer.alloc(0);
    };

    restartMenubarLaunchAgent(501, '/tmp/com.phnx-labs.agents-menubar.plist', exec);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ cmd: 'launchctl', args: ['bootout', 'gui/501/com.phnx-labs.agents-menubar'] });
    expect(calls[1]).toEqual({ cmd: 'launchctl', args: ['bootstrap', 'gui/501', '/tmp/com.phnx-labs.agents-menubar.plist'] });
    expect(calls[2]).toEqual({ cmd: 'launchctl', args: ['kickstart', 'gui/501/com.phnx-labs.agents-menubar'] });
  });

  it('continues through launchctl errors so a partially-loaded job still gets restarted', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: args as string[] });
      throw new Error('launchctl failed');
    };

    expect(() => restartMenubarLaunchAgent(501, '/tmp/com.phnx-labs.agents-menubar.plist', exec)).not.toThrow();
    expect(calls).toHaveLength(3);
  });
});

// Regression guard for the crash loop: npm strips the ad-hoc signature the
// release bakes into MenubarHelper.app, leaving it "not signed at all" — which
// macOS 26+ SIGKILLs on launch, spinning the launchd KeepAlive service forever.
// ensureValidSignature must re-sign the copied bundle so codesign verifies.
// Exercises the real `codesign` binary (no mocking), so it only runs on macOS.
const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;
darwinOnly('ensureValidSignature (real codesign)', () => {
  function makeUnsignedBundle(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-sig-'));
    const app = path.join(dir, 'MenubarHelper.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    // A real Mach-O so codesign has something to sign; /bin/echo is stable.
    fs.copyFileSync('/bin/echo', path.join(app, 'Contents', 'MacOS', 'MenubarHelper'));
    // Strip the inherited system signature -> "not signed at all", the exact
    // state npm's tarball round-trip leaves the shipped ad-hoc bundle in.
    spawnSync('codesign', ['--remove-signature', app], { stdio: 'ignore' });
    return app;
  }

  it('heals an unsigned bundle so it passes codesign --verify', () => {
    const app = makeUnsignedBundle();
    expect(codesignVerifies(app)).toBe(false);
    expect(ensureValidSignature(app)).toBe(true);
    expect(codesignVerifies(app)).toBe(true);
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  });

  it('leaves an already-valid signature untouched (idempotent)', () => {
    const app = makeUnsignedBundle();
    ensureValidSignature(app);
    expect(ensureValidSignature(app)).toBe(true);
    expect(codesignVerifies(app)).toBe(true);
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  });
});
