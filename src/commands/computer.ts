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
  loadComputerAllowList,
  loadDefaultPeers,
  writeComputerPolicy,
  writeComputerPeers,
} from '../lib/computer-rpc.js';

// Help groups — mirror `agents browser` so the mental model carries over.
const COMPUTER_HELP_GROUPS = [
  { title: 'Installation', names: ['install-helper'] },
  { title: 'Daemon lifecycle', names: ['start', 'stop', 'reload', 'status'] },
  { title: 'Capture evidence', names: ['screenshot'] },
] as const;

export function registerComputerCommand(program: Command): void {
  const computer = program
    .command('computer')
    .description('Drive macOS apps via Accessibility — list, screenshot, click, type');

  registerComputerSubcommands(computer);
  registerCommandGroups(computer, COMPUTER_HELP_GROUPS);
}

export function registerComputerSubcommands(program: Command): void {
  registerInstallHelperCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerReloadCommand(program);
  registerStatusCommand(program);
  registerScreenshotCommand(program);
  registerCommandGroups(program, COMPUTER_HELP_GROUPS);
}

function reportMissingHelper(): never {
  console.error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
  process.exit(1);
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
        console.log('Run:  agents computer install-helper');
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
    .description('Capture a JPEG of the frontmost window of a bundle id (default: frontmost app)')
    .option('--bundle <id>', 'Bundle id to capture (default: bundle id of frontmost app)')
    .option('--out <path>', 'Output JPEG path', './computer-screenshot.jpg')
    .option('--quality <n>', 'JPEG quality 1-100', (v) => parseInt(v, 10), 85)
    .action(async (opts: { bundle?: string; out: string; quality: number }) => {
      const transport = describeTransport();
      if (transport.kind === 'none') reportMissingHelper();

      const quality = Math.max(1, Math.min(100, opts.quality || 85));

      const client = openComputerClient();
      try {
        // Step 1: list_apps to get the candidate set.
        const apps = await client.call('list_apps');
        if (apps.error) {
          console.error(`error: ${apps.error.code}: ${apps.error.message}`);
          process.exit(1);
        }
        const list = (apps.result?.apps as Array<{
          pid: number;
          name: string;
          bundle_id: string;
          active: boolean;
          excluded: boolean;
        }>) || [];

        let target: typeof list[number] | undefined;
        if (opts.bundle) {
          target = list.find((a) => a.bundle_id === opts.bundle);
          if (!target) {
            console.error(`bundle not in allow list (or not running): ${opts.bundle}`);
            console.error(`add Computer(${opts.bundle}) to a permissions group, then \`agents computer reload\``);
            process.exit(1);
          }
        } else {
          target = list.find((a) => a.active);
          if (!target) {
            console.error('no active app found in allow list');
            console.error('add Computer(<bundle-id>) to a permissions group, then `agents computer reload`');
            process.exit(1);
          }
        }

        // Step 2: screenshot.
        const shot = await client.call('screenshot', { pid: target.pid, quality });
        if (shot.error) {
          console.error(`error: ${shot.error.code}: ${shot.error.message}`);
          process.exit(1);
        }
        const b64 = shot.result?.image_data as string | undefined;
        const width = shot.result?.width as number | undefined;
        const height = shot.result?.height as number | undefined;
        if (!b64) {
          console.error('helper returned no image_data');
          process.exit(1);
        }
        const buf = Buffer.from(b64, 'base64');
        const outPath = path.resolve(opts.out);
        fs.writeFileSync(outPath, buf);
        console.log(`saved: ${outPath} (${width ?? '?'}x${height ?? '?'}, ${buf.byteLength} bytes)`);
      } finally {
        await client.close();
      }
    });
}

// install-helper:
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

function registerInstallHelperCommand(program: Command): void {
  program
    .command('install-helper')
    .description('Install ComputerHelper.app to /Applications/ (does NOT activate the daemon — run `start` to enable)')
    .action(async () => {
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
    .description('Activate the helper daemon (loads launchd, opens socket)')
    .action(async () => {
      const home = os.homedir();
      const plistPath = path.join(home, 'Library', 'LaunchAgents', `${HELPER_LABEL}.plist`);
      const socketPath = resolveSocketPath();
      const logPath = resolveLogPath();

      if (!fs.existsSync(plistPath)) {
        console.error(`plist not found at ${plistPath}`);
        console.error('run: agents computer install-helper');
        process.exit(1);
      }
      if (!fs.existsSync(HELPER_APP_DEST)) {
        console.error(`helper app not found at ${HELPER_APP_DEST}`);
        console.error('run: agents computer install-helper');
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
    .description('Deactivate the helper daemon (bootout, removes socket)')
    .action(async () => {
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
