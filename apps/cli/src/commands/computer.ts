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
} from '../lib/computer/computer-rpc.js';
import {
  setupRemoteHelper,
  startRemoteTunnel,
  stopRemoteHelper,
  hydrateRemoteEnvFromState,
  readRemoteState,
  resolveRemoteDevice,
  REMOTE_TASK_NAME,
  WIN_HELPER_EXE,
} from '../lib/computer/ssh-tunnel.js';
import { sshExec } from '../lib/ssh-exec.js';
import { encodePowershell } from '../lib/hosts/remote-cmd.js';
import { registerActionCommands, withClient, unwrap, pickTarget, emitComputerAction, type AppInfo } from './computer-actions.js';
import { runComputerLoop, type LoopEvent } from '../lib/computer/loop.js';
import { makeVerbDispatcher } from '../lib/computer/dispatch.js';
import { makeClaudeResponder, resolveApiKey, DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_BASE_URL } from '../lib/computer/model.js';
import { TASK_PREVIEW_MAX_CHARS } from '../lib/computer/sessions-list.js';
import { runComputerSessionsCommand } from './computer-sessions-picker.js';
import { truncate } from '../lib/feed/events.js';
import { namespacedServiceLabel, serviceManifestHomeEnv, serviceManagerRegistrationAllowed } from '../lib/service-manifest.js';

// Help groups — mirror `agents browser` so the mental model carries over.
const COMPUTER_HELP_GROUPS = [
  { title: 'Installation', names: ['setup'] },
  { title: 'Daemon lifecycle', names: ['start', 'stop', 'reload', 'status'] },
  { title: 'Autonomous', names: ['run'] },
  { title: 'Observe', names: ['apps', 'describe', 'screenshot', 'get-text'] },
  { title: 'Interact', names: ['launch', 'raise', 'click', 'right-click', 'type', 'type-text', 'key', 'drag', 'scroll', 'ax-action', 'focus', 'wait'] },
  { title: 'History and discovery', names: ['sessions'] },
] as const;

// Subcommands that manage the `--device` remote path themselves (provisioning /
// tunnel lifecycle, or daemon-state reporting that must degrade gracefully
// when no tunnel is recorded). Every other `--device`-bearing subcommand is a
// plain verb that just needs the TCP endpoint hydrated before it runs.
const REMOTE_LIFECYCLE = new Set(['setup', 'start', 'stop', 'status', 'reload']);

/**
 * Pure platform gate. The computer subsystem is macOS-only for LOCAL driving
 * (Accessibility / launchctl). It is NOT blocked off macOS when a remote daemon
 * is reachable — either a configured TCP endpoint (COMPUTER_HELPER_TCP, e.g. a
 * Windows daemon over a tunnel) or a `--device <name>` remote invocation. Kept
 * pure so the gating rule is unit-testable without a live command tree.
 */
export function shouldBlockOffPlatform(opts: {
  platform: NodeJS.Platform;
  tcpConfigured: boolean;
  device?: string;
}): boolean {
  if (opts.platform === 'darwin') return false;
  if (opts.tcpConfigured) return false; // remote (Windows) daemon over a tunnel
  if (opts.device) return false; // remote path resolves its own endpoint
  return true;
}

/**
 * Sniff the image format from the leading magic bytes: PNG starts with the
 * 8-byte signature `89 50 4E 47` ("\x89PNG"), JPEG with `FF D8 FF`. Returns the
 * canonical file extension, or null for anything else.
 */
export function detectImageFormat(buf: Buffer): '.png' | '.jpg' | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  return null;
}

/**
 * Make the screenshot filename honest about its bytes. The two helper backends
 * encode DIFFERENT formats and neither re-encodes to match the requested name:
 * the macOS helper (ScreenCaptureKit) returns JPEG
 * (native/computer-mac/Sources/ComputerHelper/Screenshot.swift:207,212),
 * the Windows helper returns PNG
 * (native/computer-win/Screenshot.cs:33). So a fixed default extension
 * cannot be correct for both — the only honest path is to sniff the real format
 * and swap the extension to match. Pure so it's unit-testable.
 *
 * Returns the path to write to (caller's path with its extension corrected) and
 * whether a correction was made. Unknown formats pass through unchanged.
 */
export function reconcileScreenshotExt(outPath: string, buf: Buffer): { path: string; corrected: boolean } {
  const actual = detectImageFormat(buf);
  if (!actual) return { path: outPath, corrected: false };
  const cur = path.extname(outPath).toLowerCase();
  const alreadyMatches = cur === actual || (actual === '.jpg' && (cur === '.jpg' || cur === '.jpeg'));
  if (alreadyMatches) return { path: outPath, corrected: false };
  const base = outPath.slice(0, outPath.length - path.extname(outPath).length);
  return { path: base + actual, corrected: true };
}

export function registerComputerCommand(program: Command): void {
  const computer = program
    .command('computer')
    .description('Drive macOS apps via Accessibility, or a remote Windows device with --device — list, screenshot, click, type')
    // The whole subsystem is macOS Accessibility / TCC for LOCAL driving. Off
    // macOS it still works against a remote daemon (COMPUTER_HELPER_TCP set, or
    // a `--device <name>` invocation). Fail fast with a clear message only when
    // neither remote path is available, instead of a downstream launchctl error.
    .hook('preAction', async (_thisCommand, actionCommand) => {
      const device = actionCommand.opts().device as string | undefined;
      // Verbs with --device reconnect to the tunnel `start --device` recorded;
      // this sets COMPUTER_HELPER_TCP so the shared client picks the TCP transport.
      if (device && !REMOTE_LIFECYCLE.has(actionCommand.name())) {
        hydrateRemoteEnvFromState(device);
      }
      if (shouldBlockOffPlatform({ platform: process.platform, tcpConfigured: resolveTcpEndpoint() != null, device })) {
        console.error('agents computer: macOS only for local driving — it uses the macOS Accessibility API.');
        console.error('For a remote Windows device: register it with `agents devices`, then use --device (or set COMPUTER_HELPER_TCP).');
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
  registerRunCommand(program);
  registerScreenshotCommand(program);
  registerActionCommands(program);
  registerSessionsCommand(program);
  registerCommandGroups(program, COMPUTER_HELP_GROUPS);
}

function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Report install state, daemon state, and Accessibility trust — or a remote Windows daemon with --device')
    .option('--device <name>', 'Report the remote Windows daemon (tunnel + liveness) instead of the local helper')
    .action(async (opts: { device?: string }) => {
      if (opts.device) {
        await reportRemoteStatus(opts.device);
        return;
      }
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

// status --device: the local checks (app install, launchd socket, policy files)
// are macOS concepts — a remote Windows daemon is reported from what actually
// exists for it: the recorded tunnel and a live trust_status probe through it.
async function reportRemoteStatus(device: string): Promise<void> {
  console.log(`device:    ${device}`);
  const state = readRemoteState(device);
  if (!state) {
    console.log('tunnel:    none');
    console.log('daemon:    unknown (no tunnel to probe through)');
    console.log('');
    console.log(`Run:  agents computer start --device ${device}`);
    process.exit(1);
  }
  console.log(`tunnel:    127.0.0.1:${state.localPort} -> ${state.target} (127.0.0.1:${state.remotePort})`);
  hydrateRemoteEnvFromState(device);
  try {
    const client = openComputerClient();
    try {
      const r = await client.call('trust_status');
      if (r.error) {
        console.error(`error: ${r.error.code}: ${r.error.message}`);
        process.exit(1);
      }
      console.log('daemon:    running');
      console.log(`trust:     ${r.result?.trusted ? 'granted' : 'denied'} (Windows UIAutomation needs no per-app grant)`);
      if (typeof r.result?.pid === 'number') console.log(`pid:       ${r.result.pid}`);
      if (typeof r.result?.path === 'string' && r.result.path) console.log(`exe:       ${r.result.path}`);
    } finally {
      await client.close();
    }
  } catch (err) {
    console.log('daemon:    unreachable');
    console.log(`           ${(err as Error).message}`);
    console.log('');
    console.log(`Run:  agents computer start --device ${device}`);
    process.exit(1);
  }
}

// PowerShell to bounce the remote daemon: kill the running exe (tolerating
// "not running"), then start the LOGON scheduled task that owns its
// lifecycle. Pure so tests can assert the exact script (mirrors the
// ssh-tunnel script builders).
export function buildRestartTaskScript(taskName: string, exeName: string): string {
  const procName = exeName.replace(/\.exe$/i, '');
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Stop-Process -Name '${procName}' -Force -ErrorAction SilentlyContinue`,
    `Start-ScheduledTask -TaskName '${taskName}'`,
    `Write-Output 'restarted'`,
  ].join('; ');
}

// reload --device: the Windows daemon has no policy file to re-read (it
// enforces no allow-list — see TrustStatus in native/computer-win/Rpc.cs), so
// reload means bounce the daemon via its scheduled task — the way to pick up
// a freshly pushed exe — then prove it answers through the recorded tunnel.
async function reloadRemoteHelper(device: string): Promise<void> {
  const { target } = await resolveRemoteDevice(device);
  const script = buildRestartTaskScript(REMOTE_TASK_NAME, WIN_HELPER_EXE);
  const res = sshExec(
    target,
    `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowershell(script)}`,
    { timeoutMs: 60_000 },
  );
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || '').trim();
    console.error(`restart failed on ${target}${res.timedOut ? ' (timed out)' : ''}${msg ? `: ${msg}` : ''}`);
    process.exit(1);
  }
  console.log(`task:   restarted "${REMOTE_TASK_NAME}" on ${target}`);

  const state = readRemoteState(device);
  if (!state) {
    console.log(`(no tunnel recorded — run \`agents computer start --device ${device}\` to drive it)`);
    return;
  }
  hydrateRemoteEnvFromState(device);
  // The relaunched daemon needs a beat to rebind its port; poll through the
  // tunnel until it answers.
  const deadline = Date.now() + 15_000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const client = openComputerClient();
      try {
        const r = await client.call('trust_status');
        if (!r.error && r.result) {
          console.log(`reloaded: daemon answering (pid ${r.result.pid ?? '?'})`);
          return;
        }
        lastErr = r.error ? `${r.error.code}: ${r.error.message}` : 'empty result';
      } finally {
        await client.close();
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await sleep(500);
  }
  console.error(`daemon did not answer within 15s after restart${lastErr ? ` (${lastErr})` : ''}`);
  process.exit(1);
}

// run — the embedded observe -> act -> verify agent loop. A reasoning model
// (Claude API by default, or any Anthropic-shaped endpoint via --base-url for
// Ollama / vLLM / LiteLLM) drives the EXISTING computer verbs as tools over the
// daemon socket. New subcommand: the explicit verb interface external agents
// use is unchanged. The loop auto-switches to the screenshot/coordinate path
// when an app's AX tree comes back opaque (WebView / canvas).
function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Autonomously drive an app from a natural-language task (embedded model loop over the computer verbs)')
    .requiredOption('--task <s>', 'Natural-language task, e.g. "open Notes and write a haiku"')
    .option('--bundle <id>', 'Bundle id to focus the loop on (default: frontmost allow-listed app)')
    .option('--base-url <url>', `Reasoning model base URL — Anthropic wire shape (default: ${DEFAULT_CLAUDE_BASE_URL}; set to a local Ollama/vLLM/LiteLLM endpoint for offline parity)`)
    .option('--model <id>', `Model id (default: ${DEFAULT_CLAUDE_MODEL})`)
    .option('--max-steps <n>', 'Max model turns before giving up', (v) => parseInt(v, 10), 12)
    .option('--max-tokens <n>', 'Max tokens per model turn', (v) => parseInt(v, 10), 1024)
    .option('--device <name>', 'Drive a remote Windows device (requires `agents computer start --device <name>` first)')
    .option('--json', 'Emit the final loop result as JSON')
    .action(async (opts: {
      task: string;
      bundle?: string;
      baseUrl?: string;
      model?: string;
      maxSteps: number;
      maxTokens: number;
      device?: string;
      json?: boolean;
    }) => {
      const apiKey = resolveApiKey({ apiKey: undefined, baseUrl: opts.baseUrl });
      // The Claude API needs a key; a local/offline endpoint (non-default base
      // URL) usually ignores it, so only hard-fail on the default endpoint.
      if (!apiKey && !opts.baseUrl) {
        console.error('no API key. Set ANTHROPIC_API_KEY (or AGENTS_COMPUTER_API_KEY), or point --base-url at a local endpoint.');
        process.exit(1);
      }

      const responder = makeClaudeResponder({
        baseUrl: opts.baseUrl,
        model: opts.model,
        maxTokens: opts.maxTokens,
      });

      emitComputerRunTaskMarker({ task: opts.task, bundle: opts.bundle, device: opts.device });

      await withClient(async (client) => {
        const dispatch = makeVerbDispatcher(client, { device: opts.device });
        const targetInput = opts.bundle ? { bundle: opts.bundle } : {};

        const result = await runComputerLoop({
          task: opts.task,
          responder: (state) => responder({ ...state, task: describeTaskWithTarget(opts.task, opts.bundle) }),
          dispatch: (call) => dispatch({ ...call, input: { ...targetInput, ...call.input } }),
          maxSteps: opts.maxSteps,
          onEvent: opts.json ? undefined : (e) => printLoopEvent(e),
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log('');
        if (result.status === 'done') {
          console.log(`done (${result.turns} turn${result.turns === 1 ? '' : 's'}): ${result.finalText ?? ''}`);
        } else {
          console.log(`stopped: hit max-steps (${result.turns} turns) without a completion signal`);
        }
      });
    });
}

// sessions — task-first history over the computer.action event ledger (RUSH-2432),
// the computer counterpart of `agents browser sessions` (RUSH-2407). `agents
// sessions --computer` (sessions.ts) routes to the same runComputerSessionsCommand.
function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('Browse computer-driving history, grouped by run — one row per `agents computer` invocation')
    .option('--machine <name>', 'Only rows invoked from/driving this machine (hostname, machineId, or --device name)')
    .option('--limit <n>', 'Cap the flat/--no-interactive table at this many rows (default 50; --json is unbounded)', (v) => parseInt(v, 10))
    .option('--json', 'Emit machine-readable JSON')
    .option('--no-interactive', 'Print the flat listing instead of opening the interactive run browser')
    .action(async (opts: { machine?: string; limit?: number; json?: boolean; interactive?: boolean }) => {
      await runComputerSessionsCommand({ machine: opts.machine, limit: opts.limit, json: opts.json, interactive: opts.interactive });
    });
}

/**
 * Emit a `computer.action` marker for `computer run`'s whole loop process, so
 * `agents computer sessions` groups every verb the loop drives under one
 * task-labeled row instead of a bare pid with no task text (see
 * lib/computer/sessions-list.ts's "Grouping key" docblock note). The task
 * text is bounded to `TASK_PREVIEW_MAX_CHARS` — never the full unbounded
 * `--task` string — matching that module's retention/privacy note. Exported
 * so the truncation behavior is directly unit-testable against the real
 * event ledger, the same seam `computer-actions.test.ts` already uses for
 * `emitComputerAction`.
 */
export function emitComputerRunTaskMarker(opts: { task: string; bundle?: string; device?: string }): void {
  emitComputerAction('run', undefined, { bundle: opts.bundle, device: opts.device }, {
    task: truncate(opts.task, TASK_PREVIEW_MAX_CHARS),
  });
}

// Fold the target bundle into the task text so the model biases toward it.
function describeTaskWithTarget(task: string, bundle?: string): string {
  return bundle ? `${task}\n(Target app bundle id: ${bundle})` : task;
}

// Human progress line per loop event — verb + a one-line result digest.
function printLoopEvent(e: LoopEvent): void {
  if (e.kind === 'turn') {
    console.log(`--- turn ${e.index + 1} ---`);
  } else if (e.kind === 'dispatch') {
    const tag = e.visionFallback ? ' [ax opaque]' : '';
    const status = e.result.ok ? 'ok' : `error: ${e.result.error ?? 'unknown'}`;
    console.log(`  ${e.call.name}${tag} -> ${status}`);
  } else if (e.kind === 'vision_switch') {
    console.log('  (switching to vision path: screenshot + coordinate clicks)');
  } else if (e.kind === 'done') {
    console.log(`  model: ${e.text}`);
  }
}

function registerScreenshotCommand(program: Command): void {
  program
    .command('screenshot')
    .description('Capture a window (default: largest), enumerate windows (--list), or the whole display (--display)')
    .option('--bundle <id>', 'Bundle id to capture (default: frontmost allow-listed app)')
    .option('--pid <n>', 'Target pid directly (overrides --bundle)', (v) => parseInt(v, 10))
    .option('--device <name>', 'Drive a remote Windows device (requires `agents computer start --device <name>` first)')
    .option('--list', 'List the app\'s windows (id/title/layer/bounds) instead of capturing — reveals modals/popups')
    .option('--window-id <n>', 'Capture a specific window by id (from --list)', (v) => parseInt(v, 10))
    .option('--display', 'Capture the whole display the app is on (composites stacked modals)')
    .option('--out <path>', 'Output image path — extension auto-corrected to the encoded format (JPEG on macOS, PNG on a Windows --device)', './computer-screenshot.jpg')
    .option('--quality <n>', 'JPEG quality 1-100 (macOS capture only; the Windows helper encodes lossless PNG and ignores this)', (v) => parseInt(v, 10), 85)
    .option('--json', 'Emit JSON (metadata for captures; window list for --list)')
    .action(async (opts: {
      bundle?: string;
      pid?: number;
      device?: string;
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
          emitComputerAction('screenshot', pid, opts, { list: true });
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
        emitComputerAction('screenshot', pid, opts, { display: opts.display, windowId: opts.windowId });
        const buf = Buffer.from(b64, 'base64');
        // Sniff the real format and correct the extension so the filename never
        // lies about its bytes (macOS -> JPEG, Windows helper -> PNG).
        const requested = path.resolve(opts.out);
        const { path: outPath, corrected } = reconcileScreenshotExt(requested, buf);
        fs.writeFileSync(outPath, buf);

        if (opts.json) {
          // Drop the heavy base64 from the metadata echo; report where it went.
          const meta = { ...res, image_data: `<saved to ${outPath}>` };
          console.log(JSON.stringify(meta, null, 2));
        } else {
          if (corrected) {
            console.log(`note: bytes are ${path.extname(outPath).slice(1).toUpperCase()}; corrected extension from ${path.basename(requested)}`);
          }
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
/**
 * launchd Label for this process's helper — the production identifier for a real
 * invocation, namespaced under a redirected HOME (RUSH-2639). launchd routes
 * bootout/bootstrap/kickstart/print by identifier alone, never by the plist's
 * path, so without this a process running under a sandbox HOME tears down the
 * operator's live helper.
 */
export function helperLabel(): string {
  return namespacedServiceLabel(HELPER_BUNDLE_ID);
}

/**
 * Install the macOS helper locally: resolve (or download + verify) the signed,
 * notarized .app, copy it to /Applications, verify the destination signature,
 * and write the LaunchAgent plist (inactive — activation is a separate opt-in
 * step via `start`). Throws on any failure. Shared by `agents computer setup`
 * and the unified `agents setup computer` wizard so there is one install path.
 */
export async function installComputerHelperMacLocal(): Promise<{ appDest: string; plistPath: string }> {
  let srcApp = resolveHelperApp();
  if (!srcApp || !fs.existsSync(srcApp)) {
    // No local build / bundled copy (the normal case on an npm-installed CLI).
    // Fetch the signed + notarized helper release asset for this CLI version;
    // it is sha256- and signature-verified before we touch /Applications.
    const { ensureMacHelperApp } = await import('../lib/computer/download.js');
    srcApp = await ensureMacHelperApp();
    console.log(`helper:  ${srcApp} (downloaded + verified)`);
  }

  const socketPath = resolveSocketPath();
  const logPath = resolveLogPath();
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${helperLabel()}.plist`);

  console.log(`source:  ${srcApp}`);
  console.log(`dest:    ${HELPER_APP_DEST}`);

  // 1. Copy to /Applications/ via ditto (preserves xattrs + codesign metadata).
  if (fs.existsSync(HELPER_APP_DEST)) {
    try {
      fs.rmSync(HELPER_APP_DEST, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `failed to remove prior install at ${HELPER_APP_DEST}: ${(err as Error).message}. try: sudo rm -rf "${HELPER_APP_DEST}"`,
      );
    }
  }
  try {
    execFileSync('/usr/bin/ditto', [srcApp, HELPER_APP_DEST], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`ditto copy failed: ${(err as Error).message}`);
  }
  console.log(`copied to ${HELPER_APP_DEST}`);

  // 2. Verify codesign on the destination — TCC needs a valid signature.
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', HELPER_APP_DEST], { stdio: 'inherit' });
    console.log('codesign verify: OK');
  } catch {
    throw new Error(
      `codesign verify FAILED for ${HELPER_APP_DEST}. The destination .app is unsigned or its signature was stripped.`,
    );
  }

  // 3. Ensure socket + log parent dirs exist.
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  // 4. Write the LaunchAgent plist but DO NOT bootstrap it (opt-in via `start`).
  const execInsideApp = path.join(HELPER_APP_DEST, 'Contents', 'MacOS', 'ComputerHelper');
  const plistContent = renderLaunchAgentPlist({ label: helperLabel(), exec: execInsideApp, socketPath, logPath });
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plistContent);
  console.log(`wrote plist: ${plistPath} (NOT activated)`);

  return { appDest: HELPER_APP_DEST, plistPath };
}

/**
 * Activate the local helper daemon via launchd (render policy + peers, bootout
 * → bootstrap → kickstart, wait for the socket, probe AX trust). Throws on any
 * failure. Returns the trust status so callers can guide the permission grant.
 * Shared by `agents computer start` and the `agents setup computer` wizard.
 */
export async function activateComputerHelperMacLocal(): Promise<{ trusted: boolean; socketPath: string; logPath: string }> {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${helperLabel()}.plist`);
  const socketPath = resolveSocketPath();
  const logPath = resolveLogPath();

  if (!fs.existsSync(plistPath)) throw new Error(`plist not found at ${plistPath}. run: agents computer setup`);
  if (!fs.existsSync(HELPER_APP_DEST)) throw new Error(`helper app not found at ${HELPER_APP_DEST}. run: agents computer setup`);

  const uid = process.getuid?.();
  if (typeof uid !== 'number') throw new Error('cannot resolve uid');

  const reg = serviceManagerRegistrationAllowed();
  if (!reg.allowed) {
    throw new Error(reg.reason);
  }

  const domain = `gui/${uid}`;

  // Render the policy file BEFORE bootstrap so the daemon reads a fresh allow
  // list at startup (fail-safe: missing/unparseable → everything denied).
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

  // Peer-auth allow list — which caller executables may connect to the socket.
  const callers = loadDefaultPeers();
  writeComputerPeers(callers);
  console.log(`peers:  ${callers.length} caller${callers.length === 1 ? '' : 's'} allowed (${resolvePeersPath()})`);
  for (const p of callers) console.log(`        ${p}`);

  // Bootout first to clear any prior registration (best-effort).
  try {
    execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'pipe' });
  } catch {
    // expected when not previously loaded
  }
  try {
    execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`launchctl bootstrap failed: ${(err as Error).message}`);
  }
  // Force restart so we pick up the latest binary.
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${helperLabel()}`], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`launchctl kickstart failed: ${(err as Error).message}`);
  }

  // Wait up to 5s for the socket.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) break;
    await sleep(100);
  }
  if (!fs.existsSync(socketPath)) {
    throw new Error(`socket did not appear at ${socketPath} within 5s. check ${logPath} for helper startup errors`);
  }

  // Probe trust through the socket.
  let trusted = false;
  let trustStr = 'unknown';
  try {
    const client = openComputerClient();
    try {
      const r = await client.call('trust_status');
      trusted = Boolean(r.result?.trusted);
      trustStr = r.error ? `error (${r.error.code})` : (trusted ? 'granted' : 'denied');
    } finally {
      await client.close();
    }
  } catch (err) {
    trustStr = `error (${(err as Error).message})`;
  }

  console.log(`daemon: running`);
  console.log(`socket: ${socketPath}`);
  console.log(`trust:  ${trustStr}`);
  return { trusted, socketPath, logPath };
}

/** Probe the running daemon's Accessibility trust status without re-activating.
 * Returns false (never throws) if the socket is down or the RPC errors — used to
 * poll while the user grants permissions in System Settings. */
export async function probeComputerTrust(): Promise<boolean> {
  try {
    const client = openComputerClient();
    try {
      const r = await client.call('trust_status');
      return Boolean(r.result?.trusted);
    } finally {
      await client.close();
    }
  } catch {
    return false;
  }
}

function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .alias('install-helper')
    .description('Install the helper — locally to /Applications/ (macOS), or to a remote Windows device with --device')
    .option('--device <name>', 'Provision a remote Windows device (push the exe + register a LOGON task) instead of installing locally')
    .action(async (opts: { device?: string }) => {
      if (opts.device) {
        try {
          const { target, taskName } = await setupRemoteHelper(opts.device);
          console.log(`pushed computer-helper-win.exe to ${target}`);
          console.log(`registered LOGON scheduled task "${taskName}" (interactive session, started now)`);
          console.log('');
          console.log(`Next:  agents computer start --device ${opts.device}`);
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      let plistPath: string;
      try {
        ({ plistPath } = await installComputerHelperMacLocal());
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }

      console.log('');
      console.log('Helper installed (inactive).');
      console.log('');
      console.log(`  app:    ${HELPER_APP_DEST}`);
      console.log(`  plist:  ${plistPath}`);
      console.log('');
      console.log('Next steps:');
      console.log('  1. Grant TCC permissions (one-time):');
      console.log('     System Settings > Privacy & Security > Accessibility       — add Agents Computer');
      console.log('     System Settings > Privacy & Security > Screen Recording    — add Agents Computer');
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
    .description('Activate the helper daemon — local launchd (macOS) or a remote Windows tunnel with --device')
    .option('--device <name>', 'Open a tunnel to the remote Windows daemon and record it for --device verbs')
    .action(async (opts: { device?: string }) => {
      if (opts.device) {
        try {
          const state = await startRemoteTunnel(opts.device);
          console.log(`tunnel: 127.0.0.1:${state.localPort} -> ${state.target} (127.0.0.1:${state.remotePort})`);
          console.log(`daemon: answering (ssh pid ${state.tunnelPid})`);
          console.log('');
          console.log(`Drive it:  agents computer apps --device ${opts.device}`);
          console.log(`Stop:      agents computer stop --device ${opts.device}`);
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      let trusted: boolean;
      try {
        ({ trusted } = await activateComputerHelperMacLocal());
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
      if (!trusted) {
        console.log('');
        console.log('Grant Accessibility + Screen Recording to Agents Computer, then run `agents computer start` again.');
      }
    });
}

function registerReloadCommand(program: Command): void {
  program
    .command('reload')
    .description('Reload the allow-list policy (SIGHUP the local daemon) — or restart a remote Windows daemon with --device')
    .option('--device <name>', 'Restart the remote Windows daemon (its scheduled task) instead of SIGHUPing the local one')
    .action(async (opts: { device?: string }) => {
      if (opts.device) {
        try {
          await reloadRemoteHelper(opts.device);
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }
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
        const out = execFileSync('/bin/launchctl', ['print', `${domain}/${helperLabel()}`], { encoding: 'utf-8' });
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
    .description('Deactivate the helper daemon — local launchd (macOS) or a remote Windows tunnel with --device')
    .option('--device <name>', 'Tear down the remote tunnel and unregister the scheduled task')
    .action(async (opts: { device?: string }) => {
      if (opts.device) {
        try {
          const { tunnelKilled, taskRemoved } = await stopRemoteHelper(opts.device);
          console.log(`tunnel: ${tunnelKilled ? 'closed' : 'not running'}`);
          console.log(`task:   ${taskRemoved ? 'unregistered' : 'not removed (device offline?)'}`);
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }
        return;
      }

      const home = os.homedir();
      const plistPath = path.join(home, 'Library', 'LaunchAgents', `${helperLabel()}.plist`);
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

/**
 * The helper's launchd plist.
 *
 * The `EnvironmentVariables` dict carries HOME (RUSH-2639, see
 * `lib/service-manifest.ts`): launchd applies this dict on top of the LOGIN
 * SESSION's environment, never the environment of whoever called `launchctl
 * bootstrap`, so a manifest that omits HOME hands the helper the account home no
 * matter which home the caller resolved. That is a silent escape from any
 * redirected HOME — the hermetic test harness's, and an agent's isolated version
 * home alike.
 */
export function renderLaunchAgentPlist(opts: { label: string; exec: string; socketPath: string; logPath: string }): string {
  const envXml = Object.entries(serviceManifestHomeEnv())
    .map(([k, v]) => `        <key>${escapeXml(k)}</key>\n        <string>${escapeXml(v)}</string>`)
    .join('\n');
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
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
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
