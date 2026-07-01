import { Command } from 'commander';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerCommandGroups } from '../lib/help.js';
import {
  openComputerClient,
  resolveHelperApp,
  resolveHelperExec,
  resolveSocketPath,
  resolveLogPath,
  resolvePolicyPath,
  resolvePeersPath,
  describeTransport,
  resolveTcpEndpoint,
  loadComputerAllowList,
  loadDefaultPeers,
  writeComputerPolicy,
  writeComputerPeers,
} from '../lib/computer-rpc.js';
import {
  setupRemoteHelper,
  startRemoteTunnel,
  stopRemoteHelper,
  hydrateRemoteEnvFromState,
} from '../lib/ssh-tunnel.js';
import { registerActionCommands, withClient, unwrap, pickTarget, type AppInfo } from './computer-actions.js';

// Help groups — mirror `agents browser` so the mental model carries over.
const COMPUTER_HELP_GROUPS = [
  { title: 'Installation', names: ['setup'] },
  { title: 'Daemon lifecycle', names: ['start', 'stop', 'reload', 'status'] },
  { title: 'Observe', names: ['apps', 'describe', 'screenshot', 'get-text'] },
  { title: 'Interact', names: ['launch', 'raise', 'click', 'right-click', 'type', 'type-text', 'key', 'drag', 'scroll', 'ax-action', 'focus', 'wait'] },
] as const;

// Subcommands that manage the `--host` remote path themselves (provisioning /
// tunnel lifecycle). Every other `--host`-bearing subcommand is a plain verb
// that just needs the TCP endpoint hydrated before it runs.
const REMOTE_LIFECYCLE = new Set(['setup', 'start', 'stop']);

/**
 * Pure platform gate. The computer subsystem is macOS-only for LOCAL driving
 * (Accessibility / launchctl). It is NOT blocked off macOS when a remote daemon
 * is reachable — either a configured TCP endpoint (COMPUTER_HELPER_TCP, e.g. a
 * Windows daemon over a tunnel) or a `--host <device>` remote invocation. Kept
 * pure so the gating rule is unit-testable without a live command tree.
 */
export function shouldBlockOffPlatform(opts: {
  platform: NodeJS.Platform;
  tcpConfigured: boolean;
  host?: string;
}): boolean {
  if (opts.platform === 'darwin') return false;
  if (opts.tcpConfigured) return false; // remote (Windows) daemon over a tunnel
  if (opts.host) return false; // remote path resolves its own endpoint
  return true;
}

export function registerComputerCommand(program: Command): void {
  const computer = program
    .command('computer')
    .description('Drive macOS apps via Accessibility, or a remote Windows host with --host — list, screenshot, click, type')
    // The whole subsystem is macOS Accessibility / TCC for LOCAL driving. Off
    // macOS it still works against a remote daemon (COMPUTER_HELPER_TCP set, or
    // a `--host <device>` invocation). Fail fast with a clear message only when
    // neither remote path is available, instead of a downstream launchctl error.
    .hook('preAction', async (_thisCommand, actionCommand) => {
      const host = actionCommand.opts().host as string | undefined;
      // Verbs with --host reconnect to the tunnel `start --host` recorded; this
      // sets COMPUTER_HELPER_TCP so the shared client picks the TCP transport.
      if (host && !REMOTE_LIFECYCLE.has(actionCommand.name())) {
        hydrateRemoteEnvFromState(host);
      }
      if (shouldBlockOffPlatform({ platform: process.platform, tcpConfigured: resolveTcpEndpoint() != null, host })) {
        console.error('agents computer: macOS only for local driving — it uses the macOS Accessibility API.');
        console.error('For a remote Windows host: register it with `agents devices`, then use --host (or set COMPUTER_HELPER_TCP).');
        process.exit(1);
      }
    });

  registerComputerSubcommands(computer);
  registerCommandGroups(computer, COMPUTER_HELP_GROUPS);
}

export function registerComputerSubcommands(program: Command): void {
  registerSetupCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerReloadCommand(program);
  registerStatusCommand(program);
  registerScreenshotCommand(program);
  registerActionCommands(program);
  registerCommandGroups(program, COMPUTER_HELP_GROUPS);
}

function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Report install state, daemon state, and Accessibility trust')
    .action(async () => {
      const socketPath = resolveSocketPath();
      const installed = fs.existsSync(HELPER_APP_DEST);
      const socketUp = fs.existsSync(socketPath);

      console.log(`installed: ${installed ? 'yes' : 'no'} (${HELPER_APP_DEST})`);
      console.log(`daemon:    ${socketUp ? 'running' : 'stopped'}`);

      // Show the current allow list — what the user has actually authorized
      // via Computer(...) patterns in their permission groups.
      const allowed = loadComputerAllowList();
      const previewParts = allowed.slice(0, 5);
      const previewSuffix = allowed.length > 5 ? ` (+${allowed.length - 5} more)` : '';
      console.log(`policy:    ${allowed.length} app${allowed.length === 1 ? '' : 's'} allowed${allowed.length > 0 ? `: ${previewParts.join(', ')}${previewSuffix}` : ''}`);

      const callers = loadDefaultPeers();
      console.log(`peers:     ${callers.length} caller${callers.length === 1 ? '' : 's'} (peer-auth on socket)`);

      if (!installed) {
        console.log('');
        console.log('Run:  agents computer setup');
        return;
      }
      if (!socketUp) {
        console.log('');
        console.log('Run:  agents computer start');
        return;
      }

      // Daemon is up — probe trust state.
      const client = openComputerClient();
      try {
        const r = await client.call('trust_status');
        if (r.error) {
          console.error(`error: ${r.error.code}: ${r.error.message}`);
          process.exit(1);
        }
        const trusted = Boolean(r.result?.trusted);
        const helperPid = r.result?.pid;
        console.log(`trust:     ${trusted ? 'granted' : 'denied'}`);
        if (typeof helperPid === 'number') console.log(`pid:       ${helperPid}`);
        if (!trusted) {
          console.log('');
          console.log('Grant Accessibility + Screen Recording in System Settings, then `agents computer start` again.');
        }
      } finally {
        await client.close();
      }
    });
}

function registerScreenshotCommand(program: Command): void {
  program
    .command('screenshot')
    .description('Capture a window (default: largest), enumerate windows (--list), or the whole display (--display)')
    .option('--bundle <id>', 'Bundle id to capture (default: frontmost allow-listed app)')
    .option('--pid <n>', 'Target pid directly (overrides --bundle)', (v) => parseInt(v, 10))
    .option('--host <device>', 'Drive a remote Windows device (requires `agents computer start --host <device>` first)')
    .option('--list', 'List the app\'s windows (id/title/layer/bounds) instead of capturing — reveals modals/popups')
    .option('--window-id <n>', 'Capture a specific window by id (from --list)', (v) => parseInt(v, 10))
    .option('--display', 'Capture the whole display the app is on (composites stacked modals)')
    .option('--out <path>', 'Output JPEG path', './computer-screenshot.jpg')
    .option('--quality <n>', 'JPEG quality 1-100', (v) => parseInt(v, 10), 85)
    .option('--json', 'Emit JSON (metadata for captures; window list for --list)')
    .action(async (opts: {
      bundle?: string;
      pid?: number;
      host?: string;
      list?: boolean;
      windowId?: number;
      display?: boolean;
      out: string;
      quality: number;
      json?: boolean;
    }) => {
      const quality = Math.max(1, Math.min(100, opts.quality || 85));

      await withClient(async (client) => {
        // Resolve the target pid (explicit --pid, else --bundle, else frontmost).
        let pid = opts.pid;
        if (pid == null) {
          const list = (unwrap(await client.call('list_apps')).apps as AppInfo[]) || [];
          const picked = pickTarget(list, { bundle: opts.bundle });
          if (!picked.ok) {
            console.error(picked.error);
            process.exit(1);
          }
          pid = picked.app.pid;
        }

        // --list: enumerate windows, no image.
        if (opts.list) {
          const res = unwrap(await client.call('screenshot', { pid, list: true }));
          const windows = (res.windows as Array<Record<string, unknown>>) || [];
          if (opts.json) {
            console.log(JSON.stringify(res, null, 2));
          } else if (windows.length === 0) {
            console.log('(no windows)');
          } else {
            for (const w of windows) {
              const b = (w.bounds as number[]) || [];
              console.log(`${String(w.window_id).padStart(8)}  layer ${w.layer}  [${b.join(',')}]  ${w.title || '(untitled)'}`);
            }
          }
          return;
        }

        // Capture: window (default / --window-id) or full display.
        const params: Record<string, unknown> = { pid, quality };
        if (opts.display) params.display = true;
        else if (opts.windowId != null) params.window_id = opts.windowId;

        const res = unwrap(await client.call('screenshot', params));
        const b64 = res.image_data as string | undefined;
        if (!b64) {
          console.error('helper returned no image_data');
          process.exit(1);
        }
        const buf = Buffer.from(b64, 'base64');
        const outPath = path.resolve(opts.out);
        fs.writeFileSync(outPath, buf);

        if (opts.json) {
          // Drop the heavy base64 from the metadata echo; report where it went.
          const meta = { ...res, image_data: `<saved to ${outPath}>` };
          console.log(JSON.stringify(meta, null, 2));
        } else {
          const origin = (res.origin as number[]) || [];
          const originStr = origin.length === 2 ? `, origin [${origin.join(',')}], scale ${res.scale ?? '?'}` : '';
          console.log(`saved: ${outPath} (${res.width ?? '?'}x${res.height ?? '?'}, ${buf.byteLength} bytes${originStr})`);
        }
      });
    });
}

// setup (alias: install-helper):
//   1. resolve dist .app
//   2. copy to /Applications/Computer Helper.app
//   3. codesign --verify the destination
//   4. write LaunchAgent plist with absolute HOME paths
//   5. launchctl bootout (ignore failure) -> bootstrap -> kickstart -k
//   6. wait for socket to appear
//   7. probe trust_status, print grant instructions if needed
//
// macOS TCC is keyed by signed-bundle identity + bundle id. Putting the
// .app at a stable absolute path under /Applications/ means the AX grant
// survives across npm updates. The CLI itself is unsigned but doesn't
// need AX — it sends JSON-RPC to the daemon, which has AX.
const HELPER_BUNDLE_ID = 'com.phnx-labs.computer-helper';
const HELPER_APP_NAME = 'Computer Helper.app';
const HELPER_APP_DEST = `/Applications/${HELPER_APP_NAME}`;
const HELPER_LABEL = HELPER_BUNDLE_ID;

function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .alias('install-helper')
    .description('Install the helper — locally to /Applications/ (macOS), or to a remote Windows host with --host')
    .option('--host <device>', 'Provision a remote Windows device (push the exe + register a LOGON task) instead of installing locally')
    .action(async (opts: { host?: string }) => {
      if (opts.host) {
        try {
          const { target, taskName } = await setupRemoteHelper(opts.host);
          console.log(`pushed computer-helper-win.exe to ${target}`);
          console.log(`registered LOGON scheduled task "${taskName}" (interactive session, started now)`);
          console.log('');
          console.log(`Next:  agents computer start --host ${opts.host}`);
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      const srcApp = resolveHelperApp();
      if (!srcApp || !fs.existsSync(srcApp)) {
        console.error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
        process.exit(1);
      }

      const home = os.homedir();
      const socketPath = resolveSocketPath();
      const logPath = resolveLogPath();
      const plistPath = path.join(home, 'Library', 'LaunchAgents', `${HELPER_LABEL}.plist`);

      console.log(`source:  ${srcApp}`);
      console.log(`dest:    ${HELPER_APP_DEST}`);

      // 1. Copy to /Applications/. Use ditto to preserve xattrs (Gatekeeper
      // provenance + codesign metadata). Wipe any prior install first.
      if (fs.existsSync(HELPER_APP_DEST)) {
        try {
          fs.rmSync(HELPER_APP_DEST, { recursive: true, force: true });
          console.log(`removed prior install`);
        } catch (err) {
          console.error(`failed to remove prior install at ${HELPER_APP_DEST}: ${(err as Error).message}`);
          console.error('try: sudo rm -rf "' + HELPER_APP_DEST + '"');
          process.exit(1);
        }
      }
      try {
        execFileSync('/usr/bin/ditto', [srcApp, HELPER_APP_DEST], { stdio: 'inherit' });
      } catch (err) {
        console.error(`ditto copy failed: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(`copied to ${HELPER_APP_DEST}`);

      // 2. Verify codesign on the destination. Fail loud if the copy
      // somehow stripped the signature — TCC needs a valid signature.
      try {
        execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', HELPER_APP_DEST], { stdio: 'inherit' });
        console.log('codesign verify: OK');
      } catch {
        console.error('codesign verify FAILED. The destination .app is unsigned or its signature was stripped.');
        console.error('rebuild the helper with a Developer ID cert: ./packages/computer-helper/scripts/build.sh release');
        process.exit(1);
      }

      // 3. Ensure socket + log parent dirs exist.
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      fs.mkdirSync(path.dirname(logPath), { recursive: true });

      // 4. Write the LaunchAgent plist but DO NOT bootstrap it. The user
      // explicitly opts into running the daemon via `agents computer start`.
      // Screen Recording + Accessibility are scary permissions; we don't
      // want an always-on listener that can drive any app the user could.
      const execInsideApp = path.join(HELPER_APP_DEST, 'Contents', 'MacOS', 'ComputerHelper');
      const plistContent = renderLaunchAgentPlist({
        label: HELPER_LABEL,
        exec: execInsideApp,
        socketPath,
        logPath,
      });
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plistContent);
      console.log(`wrote plist: ${plistPath} (NOT activated)`);

      console.log('');
      console.log('Helper installed (inactive).');
      console.log('');
      console.log(`  app:    ${HELPER_APP_DEST}`);
      console.log(`  plist:  ${plistPath}`);
      console.log('');
      console.log('Next steps:');
      console.log('  1. Grant TCC permissions (one-time):');
      console.log('     System Settings > Privacy & Security > Accessibility       — add Computer Helper.app');
      console.log('     System Settings > Privacy & Security > Screen Recording    — add Computer Helper.app');
      console.log('  2. Whitelist the apps the daemon may drive. Add a YAML under ~/.agents/permissions/groups/:');
      console.log('       name: computer');
      console.log('       allow:');
      console.log('         - "Computer(com.apple.mail)"');
      console.log('         - "Computer(com.apple.notes)"');
      console.log('     Default policy is deny-all.');
      console.log('  3. When you want to use it:  agents computer start');
      console.log('  4. When you are done:         agents computer stop');
    });
}

function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Activate the helper daemon — local launchd (macOS) or a remote Windows tunnel with --host')
    .option('--host <device>', 'Open a tunnel to the remote Windows daemon and record it for --host verbs')
    .action(async (opts: { host?: string }) => {
      if (opts.host) {
        try {
          const state = await startRemoteTunnel(opts.host);
          console.log(`tunnel: 127.0.0.1:${state.localPort} -> ${state.target} (127.0.0.1:${state.remotePort})`);
          console.log(`daemon: answering (ssh pid ${state.tunnelPid})`);
          console.log('');
          console.log(`Drive it:  agents computer apps --host ${opts.host}`);
          console.log(`Stop:      agents computer stop --host ${opts.host}`);
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      const home = os.homedir();
      const plistPath = path.join(home, 'Library', 'LaunchAgents', `${HELPER_LABEL}.plist`);
      const socketPath = resolveSocketPath();
      const logPath = resolveLogPath();

      if (!fs.existsSync(plistPath)) {
        console.error(`plist not found at ${plistPath}`);
        console.error('run: agents computer setup');
        process.exit(1);
      }
      if (!fs.existsSync(HELPER_APP_DEST)) {
        console.error(`helper app not found at ${HELPER_APP_DEST}`);
        console.error('run: agents computer setup');
        process.exit(1);
      }

      const uid = process.getuid?.();
      if (typeof uid !== 'number') {
        console.error('cannot resolve uid');
        process.exit(1);
      }
      const domain = `gui/${uid}`;

      // Render the policy file BEFORE launchctl bootstrap so the daemon
      // reads a fresh allow list at startup. The helper falls back to an
      // empty allow list (everything denied) if this file is missing or
      // unparseable — fail-safe.
      const allowed = loadComputerAllowList();
      writeComputerPolicy(allowed);
      console.log(`policy: ${allowed.length} app${allowed.length === 1 ? '' : 's'} allowed (${resolvePolicyPath()})`);
      if (allowed.length > 0) {
        const preview = allowed.slice(0, 5).join(', ');
        const more = allowed.length > 5 ? ` (+${allowed.length - 5} more)` : '';
        console.log(`        ${preview}${more}`);
      } else {
        console.log(`        (no Computer(...) patterns found — everything will be denied)`);
        console.log(`        add to ~/.agents/permissions/groups/<name>.yaml under allow:`);
        console.log(`          - "Computer(com.apple.finder)"`);
      }

      // Peer-auth allow list — which caller executables may connect to
      // the socket. Default: this CLI's Node binary, plus Rush.app if
      // installed. A `nc -U socket` from a malicious npm postinstall has
      // a different exec path and gets refused at accept().
      const callers = loadDefaultPeers();
      writeComputerPeers(callers);
      console.log(`peers:  ${callers.length} caller${callers.length === 1 ? '' : 's'} allowed (${resolvePeersPath()})`);
      for (const p of callers) console.log(`        ${p}`);

      // Bootout first to clear any prior registration. Best-effort.
      try {
        execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'pipe' });
      } catch {
        // expected when not previously loaded
      }

      try {
        execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' });
      } catch (err) {
        console.error(`launchctl bootstrap failed: ${(err as Error).message}`);
        process.exit(1);
      }

      // Force restart so we pick up the latest binary.
      try {
        execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${HELPER_LABEL}`], { stdio: 'pipe' });
      } catch (err) {
        console.error(`launchctl kickstart failed: ${(err as Error).message}`);
        process.exit(1);
      }

      // Wait up to 5s for the socket.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (fs.existsSync(socketPath)) break;
        await sleep(100);
      }
      if (!fs.existsSync(socketPath)) {
        console.error(`socket did not appear at ${socketPath} within 5s`);
        console.error(`check ${logPath} for helper startup errors`);
        process.exit(1);
      }

      // Probe trust through the socket.
      let trustStr = 'unknown';
      try {
        const client = openComputerClient();
        try {
          const r = await client.call('trust_status');
          trustStr = r.error ? `error (${r.error.code})` : (r.result?.trusted ? 'granted' : 'denied');
        } finally {
          await client.close();
        }
      } catch (err) {
        trustStr = `error (${(err as Error).message})`;
      }

      console.log(`daemon: running`);
      console.log(`socket: ${socketPath}`);
      console.log(`trust:  ${trustStr}`);
      if (trustStr === 'denied') {
        console.log('');
        console.log('Grant Accessibility + Screen Recording to Computer Helper.app, then run `agents computer start` again.');
      }
    });
}

function registerReloadCommand(program: Command): void {
  program
    .command('reload')
    .description('Reload the allow-list policy from ~/.agents/permissions/groups/ (SIGHUP the daemon)')
    .action(async () => {
      const socketPath = resolveSocketPath();
      if (!fs.existsSync(socketPath)) {
        console.error(`daemon not running (no socket at ${socketPath})`);
        console.error('run: agents computer start');
        process.exit(1);
      }

      const allowed = loadComputerAllowList();
      writeComputerPolicy(allowed);
      console.log(`policy: ${allowed.length} app${allowed.length === 1 ? '' : 's'} allowed (${resolvePolicyPath()})`);

      // Rewrite peers list too — an upgrade of the npm-global CLI moves
      // its node path; without this the reloaded daemon would reject the
      // very binary that just signaled it.
      const callers = loadDefaultPeers();
      writeComputerPeers(callers);
      console.log(`peers:  ${callers.length} caller${callers.length === 1 ? '' : 's'} allowed (${resolvePeersPath()})`);

      // Resolve the daemon's pid via `launchctl list <label>`. The plist
      // output includes a "PID" key when the service is running.
      const uid = process.getuid?.();
      if (typeof uid !== 'number') {
        console.error('cannot resolve uid');
        process.exit(1);
      }
      const domain = `gui/${uid}`;

      let pid: number | null = null;
      try {
        const out = execFileSync('/bin/launchctl', ['print', `${domain}/${HELPER_LABEL}`], { encoding: 'utf-8' });
        const m = out.match(/\bpid\s*=\s*(\d+)/);
        if (m) pid = parseInt(m[1], 10);
      } catch (err) {
        console.error(`launchctl print failed: ${(err as Error).message}`);
        process.exit(1);
      }

      if (pid === null || !Number.isFinite(pid) || pid <= 0) {
        console.error('could not resolve daemon pid from launchctl print output');
        process.exit(1);
      }

      try {
        process.kill(pid, 'SIGHUP');
      } catch (err) {
        console.error(`kill -HUP ${pid} failed: ${(err as Error).message}`);
        process.exit(1);
      }

      // Brief socket-up check so the user knows the daemon survived the
      // signal (it should — SIGHUP just triggers a re-read).
      await sleep(150);
      if (!fs.existsSync(socketPath)) {
        console.error(`socket disappeared after SIGHUP — check ${resolveLogPath()}`);
        process.exit(1);
      }

      console.log(`reloaded: daemon pid ${pid}`);
      if (allowed.length > 0) {
        const preview = allowed.slice(0, 5).join(', ');
        const more = allowed.length > 5 ? ` (+${allowed.length - 5} more)` : '';
        console.log(`        ${preview}${more}`);
      }
    });
}

function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Deactivate the helper daemon — local launchd (macOS) or a remote Windows tunnel with --host')
    .option('--host <device>', 'Tear down the remote tunnel and unregister the scheduled task')
    .action(async (opts: { host?: string }) => {
      if (opts.host) {
        try {
          const { tunnelKilled, taskRemoved } = await stopRemoteHelper(opts.host);
          console.log(`tunnel: ${tunnelKilled ? 'closed' : 'not running'}`);
          console.log(`task:   ${taskRemoved ? 'unregistered' : 'not removed (device offline?)'}`);
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      const home = os.homedir();
      const plistPath = path.join(home, 'Library', 'LaunchAgents', `${HELPER_LABEL}.plist`);
      const socketPath = resolveSocketPath();

      const uid = process.getuid?.();
      if (typeof uid !== 'number') {
        console.error('cannot resolve uid');
        process.exit(1);
      }
      const domain = `gui/${uid}`;

      try {
        execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'pipe' });
      } catch {
        // already gone — fine
      }

      // launchd unlinks the socket when the daemon exits; helper also has an
      // atexit unlink. Best-effort cleanup if either path didn't fire.
      try { fs.unlinkSync(socketPath); } catch {}

      console.log('daemon: stopped');
      if (fs.existsSync(socketPath)) {
        console.warn(`(socket still present at ${socketPath} — may belong to a different process)`);
      }
    });
}

function renderLaunchAgentPlist(opts: { label: string; exec: string; socketPath: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(opts.exec)}</string>
        <string>--socket</string>
        <string>${escapeXml(opts.socketPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logPath)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backwards-compat: a few external callers may still import these.
// Re-export from the shared lib so existing imports keep working.
export { resolveHelperExec as resolveHelperPath };
export { resolveSocketPath };
