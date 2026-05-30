import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  listProfiles,
  getProfile,
  createProfile,
  deleteProfile,
  getProfileRuntimeDir,
  extractConfiguredPort,
  findFreeProfilePort,
  getEndpointPresets,
  type BrowserProfile,
} from '../lib/browser/profiles.js';
import { findBrowserPath, getPortOccupant } from '../lib/browser/chrome.js';
import {
  listProfileCacheDirs,
  removeProfileCache,
  listAllProfileSnapshots,
} from '../lib/browser/runtime-state.js';
import { DEFAULT_VIEWPORT } from '../lib/browser/devices.js';
import { discoverBrowserWsUrl, verifyBrowserIdentity } from '../lib/browser/cdp.js';
import { parseTargetFilter } from '../lib/browser/service.js';
import {
  BrowserDaemonNotRunningError,
  formatBrowserDaemonNotRunningError,
  sendIPCRequest,
} from '../lib/browser/ipc.js';
import { browserTaskPicker, type BrowserTask } from './browser-picker.js';
import { isInteractiveTerminal } from './utils.js';
import { registerCommandGroups, setHelpSections } from '../lib/help.js';

/**
 * Resolve which browser task a command targets. Order:
 *   1. `--task <name>` flag (explicit per-command override)
 *   2. `$AGENTS_BROWSER_TASK` (set once at the start of an agent run)
 *
 * Each agent process has its own environment, so the env-var path is safe for
 * parallel agents — they can't see each other's value.
 */
function resolveTaskName(opts: { task?: string }): string {
  if (opts.task) return opts.task;
  const fromEnv = process.env.AGENTS_BROWSER_TASK;
  if (fromEnv) return fromEnv;
  console.error(
    'No task specified. Pass --task <name> or set AGENTS_BROWSER_TASK in your shell.'
  );
  console.error('Tip: T=$(agents browser start --profile <p>) && export AGENTS_BROWSER_TASK=$T');
  process.exit(1);
}

// `-t` is taken by `--tab` on most commands, so `--task` is long-form only.
// Agents normally set $AGENTS_BROWSER_TASK once and never type this flag.
const TASK_OPTION_FLAG = '--task <name>';
const TASK_OPTION_DESC = 'Task name (defaults to $AGENTS_BROWSER_TASK)';

// Help groups — surfaces the actual mental model an agent follows
// ("open a session / drive the page / capture evidence / rare extras")
// instead of an alphabetical dump. Everything not listed falls into a
// trailing "Other commands" section automatically.
const BROWSER_HELP_GROUPS = [
  { title: 'Session lifecycle', names: ['start', 'done', 'status'] },
  {
    title: 'Drive the page',
    names: ['navigate', 'tabs', 'screenshot', 'evaluate', 'click', 'type', 'press', 'wait'],
  },
  {
    title: 'Capture evidence',
    names: ['console', 'errors', 'requests', 'responsebody', 'record', 'logs'],
  },
] as const;

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command('browser')
    .description('Launch and drive browser profiles via the Chrome DevTools Protocol. Power-tool for the `browser` skill.');

  setHelpSections(browser, {
    examples: `
      # List configured browser profiles
      agents browser profiles list

      # Create a Chrome profile pointed at a CDP endpoint
      agents browser profiles create work --browser chrome --endpoint http://localhost:9222

      # Start a session against a profile
      agents browser start work

      # Drive the page
      agents browser navigate https://example.com
      agents browser screenshot

      # End the session when done
      agents browser done
    `,
    notes: `
      Most agent workflows should use the 'browser' skill instead of raw subcommands.
      The skill wraps profile selection, snapshotting, and tunneling.
    `,
  });

  registerProfilesCommands(browser);
  registerTaskCommands(browser);
  registerCommandGroups(browser, BROWSER_HELP_GROUPS);
}

export function registerBrowserSubcommands(program: Command): void {
  registerProfilesCommands(program);
  registerTaskCommands(program);
  registerCommandGroups(program, BROWSER_HELP_GROUPS);
}

function registerProfilesCommands(browser: Command): void {
  const profiles = browser
    .command('profiles')
    .description('Manage browser profiles');

  profiles
    .command('list')
    .alias('ls')
    .description('List all browser profiles')
    .action(async () => {
      const allProfiles = await listProfiles();
      if (allProfiles.length === 0) {
        console.log('No browser profiles configured.');
        console.log('Create one with: agents browser profiles create <name> --endpoint <url>');
        return;
      }

      const hasDescriptions = allProfiles.some(p => p.description);
      if (hasDescriptions) {
        console.log('NAME'.padEnd(20) + 'BROWSER'.padEnd(12) + 'DESCRIPTION'.padEnd(38) + 'ENDPOINTS');
        console.log('-'.repeat(92));
        for (const p of allProfiles) {
          const presets = getEndpointPresets(p);
          const endpoints = Object.entries(presets)
            .map(([name, ep]) => (name.startsWith('endpoint-') ? ep.target : `${name}=${ep.target}`))
            .join(', ');
          const desc = (p.description ?? '').slice(0, 36).padEnd(38);
          console.log(p.name.padEnd(20) + (p.browser || '-').padEnd(12) + desc + endpoints);
        }
      } else {
        console.log('NAME'.padEnd(20) + 'BROWSER'.padEnd(12) + 'ENDPOINTS');
        console.log('-'.repeat(72));
        for (const p of allProfiles) {
          const presets = getEndpointPresets(p);
          const endpoints = Object.entries(presets)
            .map(([name, ep]) => (name.startsWith('endpoint-') ? ep.target : `${name}=${ep.target}`))
            .join(', ');
          console.log(p.name.padEnd(20) + (p.browser || '-').padEnd(12) + endpoints);
        }
      }
    });

  const VALID_BROWSERS = ['chrome', 'comet', 'chromium', 'brave', 'edge', 'custom'];

  profiles
    .command('create <name>')
    .description('Create a new browser profile')
    .requiredOption('-b, --browser <type>', `Browser type: ${VALID_BROWSERS.join(', ')}`)
    .option('-e, --endpoint <url>', 'CDP endpoint URL (repeatable; auto-assigned if omitted)', collect, [])
    .option('-s, --secrets <bundle>', 'Secrets bundle to inject')
    .option('-d, --description <text>', 'Profile description')
    .option('--headless', 'Run in headless mode')
    .option('--window <WxH>', `Window size in CSS pixels (default: ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}, MacBook Pro 14")`)
    .option('--position <X,Y>', 'Window position on screen, e.g. 80,80')
    .option('--binary <path>', 'Absolute path to the browser/app binary (required with --browser custom)')
    .option(
      '--electron',
      'Treat this profile as an Electron desktop app: never call Target.createTarget; bind to the visible window using --target-filter or the skip-invisible heuristic'
    )
    .option(
      '--target-filter <expr>',
      'Pick the visible CDP page target when the app exposes more than one. Format: url:<substring> or title:<substring>'
    )
    .action(async (name: string, opts) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        console.error('Profile name must be lowercase alphanumeric with hyphens');
        process.exit(1);
      }

      if (!VALID_BROWSERS.includes(opts.browser)) {
        console.error(`Invalid browser type. Must be one of: ${VALID_BROWSERS.join(', ')}`);
        process.exit(1);
      }

      if (opts.browser === 'custom' && !opts.binary) {
        console.error('--browser custom requires --binary <path>');
        process.exit(1);
      }

      if (opts.targetFilter) {
        // Route through the same parser the runtime uses so the CLI gate matches
        // the runtime contract — `url:` (empty value) and `url: foo` (leading
        // whitespace) both pass a naive `kind` check but produce a silent
        // heuristic fallback at runtime.
        const parsed = parseTargetFilter(String(opts.targetFilter));
        if (!parsed) {
          console.error('--target-filter must be url:<substring> or title:<substring> (non-empty value, no leading whitespace)');
          process.exit(1);
        }
        if (!opts.electron) {
          console.error('--target-filter requires --electron (the filter is only consulted on Electron profiles)');
          process.exit(1);
        }
      }

      // Auto-assign a free port if no endpoint was provided
      let endpoints: string[] = opts.endpoint;
      if (endpoints.length === 0) {
        const freePort = await findFreeProfilePort();
        endpoints = [`cdp://127.0.0.1:${freePort}`];
      }

      // Viewport is mandatory — default to MacBook Pro 14" (1512x982) if
      // --window is not provided. See lib/browser/devices.ts DEFAULT_VIEWPORT.
      let viewport: { width: number; height: number; x?: number; y?: number } = {
        width: DEFAULT_VIEWPORT.width,
        height: DEFAULT_VIEWPORT.height,
      };
      if (opts.window) {
        const m = String(opts.window).match(/^(\d+)x(\d+)$/);
        if (!m) {
          console.error(`--window must be WxH, e.g. ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}`);
          process.exit(1);
        }
        viewport.width = parseInt(m[1], 10);
        viewport.height = parseInt(m[2], 10);
      }
      if (opts.position) {
        const m = String(opts.position).match(/^(-?\d+),(-?\d+)$/);
        if (!m) {
          console.error('--position must be X,Y, e.g. 80,80');
          process.exit(1);
        }
        viewport.x = parseInt(m[1], 10);
        viewport.y = parseInt(m[2], 10);
      }

      const profile: BrowserProfile = {
        name,
        description: opts.description,
        browser: opts.browser,
        binary: opts.binary,
        electron: opts.electron || undefined,
        targetFilter: opts.targetFilter,
        endpoints,
        secrets: opts.secrets,
        chrome: opts.headless ? { headless: true } : undefined,
        viewport,
      };

      await createProfile(profile);
      console.log(`Created profile: ${name}`);
    });

  profiles
    .command('show <name>')
    .description('Show profile details')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts) => {
      const profile = await getProfile(name);
      if (!profile) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: `Profile "${name}" not found` }));
        } else {
          console.error(`Profile "${name}" not found`);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(profile, null, 2));
        return;
      }

      console.log(`Name: ${profile.name}`);
      console.log(`Browser: ${profile.browser}`);
      if (profile.binary) console.log(`Binary: ${profile.binary}`);
      if (profile.electron) console.log(`Electron: true`);
      if (profile.targetFilter) console.log(`Target filter: ${profile.targetFilter}`);
      if (profile.description) console.log(`Description: ${profile.description}`);
      const presets = getEndpointPresets(profile);
      const defaultName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
        ? profile.defaultEndpoint
        : Object.keys(presets)[0];
      console.log('Endpoints:');
      for (const [presetName, preset] of Object.entries(presets)) {
        const marker = presetName === defaultName ? ' (default)' : '';
        const isLegacy = presetName.startsWith('endpoint-');
        console.log(`  - ${isLegacy ? preset.target : `${presetName}: ${preset.target}`}${marker}`);
        if (preset.binary) console.log(`      binary: ${preset.binary}`);
        if (preset.targetFilter) console.log(`      targetFilter: ${preset.targetFilter}`);
      }
      if (profile.viewport) {
        const v = profile.viewport;
        const pos = v.x !== undefined && v.y !== undefined ? ` @ ${v.x},${v.y}` : '';
        console.log(`Viewport: ${v.width}×${v.height}${pos}`);
      }
      if (profile.secrets) console.log(`Secrets: ${profile.secrets}`);
      if (profile.chrome?.headless) console.log(`Headless: true`);
    });

  profiles
    .command('delete <name>')
    .description('Delete a browser profile (drops YAML config + all cached runtime dirs)')
    .option('--keep-cache', "Leave ~/.agents/.cache/browser/<name>* dirs in place (don't wipe chrome-data)")
    .action(async (name: string, opts: { keepCache?: boolean }) => {
      await deleteProfile(name);
      // The composite naming change introduced multiple cache dirs per
      // profile (`<name>`, `<name>@endpoint-0`, …). Sweep them all unless
      // the user explicitly wants the chrome-data preserved (e.g. for
      // re-import into a freshly-created profile of the same name).
      let removed = 0;
      if (!opts.keepCache) {
        const cacheDirs = listProfileCacheDirs(name);
        removed = cacheDirs.length;
        for (const dir of cacheDirs) {
          // `removeProfileCache` operates by profile-name; for the
          // composite dirs we already have the absolute path. Use rmSync
          // directly so we don't depend on naming round-trips.
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        // The canonical wipe also covers the legacy dir if present.
        removeProfileCache(name);
      }
      console.log(
        `Deleted profile: ${name}` +
          (removed > 0 ? ` (and ${removed} cache dir${removed === 1 ? '' : 's'})` : '')
      );
    });

  profiles
    .command('doctor <name>')
    .description('Diagnose a browser profile: binary, port, user-data-dir, onboarding state')
    .action(async (name: string) => {
      const profile = await getProfile(name);
      if (!profile) {
        console.error(`Profile "${name}" not found`);
        process.exit(1);
      }

      const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

      // 1. Binary exists for declared browser type
      try {
        const binPath = findBrowserPath(profile.browser, profile.binary);
        checks.push({ label: 'binary', ok: true, detail: binPath });
      } catch (err) {
        checks.push({
          label: 'binary',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. Configured port. For local cdp:// we check the local port. For
      //    ssh:// the port lives on a remote host — doctor's previous
      //    behavior was to lsof the LOCAL port number, which was both
      //    misleading and arbitrary (after the SSH-binds-locally change
      //    the local port now matches the remote, so a positive answer
      //    is plausible; but doctor still shouldn't report on remote
      //    state without an --remote-probe explicitly).
      const port = extractConfiguredPort(profile);
      let attachingToExistingBrowser = false;
      const firstEndpointTarget = (() => {
        const presets = getEndpointPresets(profile);
        const first = Object.keys(presets)[0];
        return first ? presets[first].target : undefined;
      })();
      const isSshEndpoint = firstEndpointTarget?.startsWith('ssh://') ?? false;
      if (port === undefined) {
        checks.push({ label: 'port', ok: true, detail: 'no port in endpoint' });
      } else if (isSshEndpoint) {
        checks.push({
          label: 'port',
          ok: true,
          detail: `${port} (remote on ${firstEndpointTarget}) — skipping local check`,
        });
      } else {
        const occupant = getPortOccupant(port);
        if (!occupant) {
          checks.push({ label: 'port', ok: true, detail: `${port} is free` });
        } else {
          try {
            const { browser } = await discoverBrowserWsUrl(port, 'localhost', profile.name);
            verifyBrowserIdentity(browser, profile.browser, port);
            checks.push({
              label: 'port',
              ok: true,
              detail: `${port} serving ${browser} (pid ${occupant.pid})`,
            });
            attachingToExistingBrowser = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            checks.push({
              label: 'port',
              ok: false,
              detail: `${port} taken by ${occupant.command} (pid ${occupant.pid}) — ${msg}`,
            });
          }
        }
      }

      // 3. User-data-dir exists and is writable
      const userDataDir = path.join(getProfileRuntimeDir(name), 'chrome-data');
      try {
        if (!fs.existsSync(userDataDir)) {
          checks.push({
            label: 'user-data-dir',
            ok: true,
            detail: `will be created at ${userDataDir}`,
          });
        } else {
          fs.accessSync(userDataDir, fs.constants.W_OK);
          checks.push({ label: 'user-data-dir', ok: true, detail: userDataDir });
        }
      } catch (err) {
        checks.push({
          label: 'user-data-dir',
          ok: false,
          detail: `${userDataDir} not writable: ${err instanceof Error ? err.message : err}`,
        });
      }

      // 4. Onboarding heuristic — only meaningful when WE will launch the
      // browser. When the configured port is already serving a debuggable
      // browser, that browser owns its own user-data-dir and the priming
      // status of our managed dir is irrelevant.
      if (attachingToExistingBrowser) {
        checks.push({
          label: 'onboarding',
          ok: true,
          detail: 'n/a (attaching to existing browser)',
        });
      } else {
        const localStatePath = path.join(userDataDir, 'Local State');
        if (fs.existsSync(localStatePath)) {
          const size = fs.statSync(localStatePath).size;
          if (size > 0) {
            checks.push({ label: 'onboarding', ok: true, detail: 'Local State present' });
          } else {
            checks.push({
              label: 'onboarding',
              ok: false,
              detail:
                'Local State is empty — run `agents browser start --profile ' +
                name +
                '` and finish any first-run screens before automating',
            });
          }
        } else {
          checks.push({
            label: 'onboarding',
            ok: false,
            detail:
              'Not initialized yet — run `agents browser start --profile ' +
              name +
              '` and finish any first-run screens before automating',
          });
        }
      }

      const allOk = checks.every((c) => c.ok);
      for (const c of checks) {
        const marker = c.ok ? 'OK  ' : 'FAIL';
        console.log(`${marker}  ${c.label.padEnd(15)} ${c.detail}`);
      }
      if (!allOk) process.exit(1);
    });

}

function registerTaskCommands(browser: Command): void {
  browser
    .command('start')
    .description('Start a browser task with a profile')
    .requiredOption('-p, --profile <name>', 'Browser profile to use')
    .option(TASK_OPTION_FLAG, 'Task name (auto-generated if omitted)')
    .option('-e, --endpoint <name>', 'Endpoint preset (defaults to the profile\'s default)')
    .option('-u, --url <url>', 'Open URL in first tab')
    .action(async (opts) => {
      const profileName: string = opts.profile;

      // Pre-check the profile locally so we fail fast with a helpful error
      // instead of round-tripping a generic "Profile not found" through the daemon.
      const profile = await getProfile(profileName);
      if (!profile) {
        console.error(`Profile "${profileName}" not found.`);
        const all = await listProfiles();
        if (all.length > 0) {
          console.error(`Available profiles: ${all.map((p) => p.name).join(', ')}`);
        }
        console.error(
          `Create one with: agents browser profiles create ${profileName} --browser <chrome|comet|chromium|brave|edge|custom>`
        );
        process.exit(1);
      }

      // Pre-check the endpoint name too — same fail-fast rationale.
      if (opts.endpoint) {
        const presets = getEndpointPresets(profile);
        if (!presets[opts.endpoint]) {
          console.error(
            `Endpoint "${opts.endpoint}" not found on profile "${profileName}". ` +
              `Available: ${Object.keys(presets).join(', ')}`
          );
          process.exit(1);
        }
      }

      const response = await sendIPCRequest({
        action: 'start',
        profile: profileName,
        taskName: opts.task,
        url: opts.url,
        endpoint: opts.endpoint,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      // stdout: just the resolved name, one line, no decoration. Lets callers do:
      //   export AGENTS_BROWSER_TASK=$(agents browser start --profile work)
      console.log(response.task);

      // stderr: human-friendly commentary so a TTY user still sees what happened.
      // Shell substitution captures stdout only, so $(...) stays clean.
      if (opts.url && response.tabId) {
        console.error(`Started task "${response.task}" with tab ${response.tabId}`);
      } else {
        console.error(`Started task "${response.task}"`);
      }
      console.error(`Tip: export AGENTS_BROWSER_TASK=${response.task}`);
      console.error('Try: agents browser screenshot | agents browser console --level error');
    });

  browser
    .command('done')
    .description('Complete a task and close its tabs')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'done',
        task,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Completed task: ${task}`);
    });

  browser
    .command('stop')
    .description('Stop a browser task and close its tabs; with --profile, detach the whole profile (close browser + drop cached connection)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-p, --profile <name>', 'Detach the whole profile (incl. composite "name@endpoint") instead of stopping a single task')
    .action(async (opts) => {
      if (opts.profile) {
        const response = await sendIPCRequest({
          action: 'stop',
          profile: opts.profile,
        });
        if (!response.ok) {
          console.error(response.error);
          process.exit(1);
        }
        console.log(`Stopped profile: ${opts.profile}`);
        return;
      }

      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'stop',
        task,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Stopped task: ${task}`);
    });

  browser
    .command('navigate')
    .description('Navigate current tab to URL (creates tab if none exist)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .requiredOption('--url <url>', 'URL to navigate to')
    .option('-p, --profile <name>', 'Browser profile (optional if task is unique)')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'navigate',
        task,
        url: opts.url,
        profile: opts.profile,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Navigated ${response.tabId} to ${opts.url}`);
    });

  // Tab subcommand group
  const tab = browser.command('tab').description('Manage tabs');

  tab
    .command('add')
    .description('Open URL in new tab (becomes current)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .requiredOption('--url <url>', 'URL to open in the new tab')
    .option('-p, --profile <name>', 'Browser profile')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-add',
        task,
        url: opts.url,
        profile: opts.profile,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Opened tab ${response.tabId}: ${opts.url}`);
    });

  tab
    .command('focus <tabId>')
    .description('Switch to tab (by ID, prefix, or URL substring)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .action(async (tabId: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-focus',
        task,
        tabId,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Focused tab ${response.tabId}`);
    });

  tab
    .command('close [tabId]')
    .description('Close tab(s) — omit tabId to close all')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .action(async (tabId: string | undefined, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-close',
        task,
        tabId,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(tabId ? `Closed tab ${tabId}` : `Closed all tabs for ${task}`);
    });

  browser
    .command('tabs')
    .description('List tabs open for the current task')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-list',
        task,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.tabs ?? [], null, 2));
        return;
      }

      if (!response.tabs || response.tabs.length === 0) {
        console.log('No tabs open');
        return;
      }

      console.log('TAB'.padEnd(12) + 'URL');
      console.log('-'.repeat(70));
      for (const t of response.tabs) {
        const current = (t as { id: string; url: string; current?: boolean }).current ? ' *' : '';
        console.log(t.id.padEnd(12) + t.url.slice(0, 55) + current);
      }
    });


  browser
    .command('screenshot')
    .description('Take a screenshot — auto-saved per task; --output only needed when you want a specific path')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-o, --output <path>', 'Specific output path (otherwise auto-saved under sessions/<task>/)')
    .option(
      '-q, --quality <mode>',
      'compressed (JPEG, capped at ~100 KB — default) or raw (PNG, pixel-faithful)',
      'compressed'
    )
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (opts.quality !== 'compressed' && opts.quality !== 'raw') {
        console.error('--quality must be "compressed" or "raw"');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'screenshot',
        task,
        tabId: opts.tab,
        path: opts.output,
        quality: opts.quality,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      // stdout: just the path, so `P=$(agents browser screenshot)` works.
      console.log(response.path);

      // stderr: human commentary with size + dimensions, so an agent can
      // see at a glance what was captured without `ls -l && file` round-trips.
      const size = humanizeBytes(response.bytes);
      const dims = response.width && response.height ? `${response.width}×${response.height}` : 'unknown size';
      console.error(`Saved screenshot to ${response.path} (${size}, ${dims})`);

      // When auto-saving (no --output), surface the directory once so the
      // agent doesn't have to dirname() the path or guess where files land.
      if (!opts.output && response.path) {
        const dir = path.dirname(response.path);
        console.error(`Tip: auto-saving to ${dir}. Pass --output <path> to choose a path.`);
      }
    });

  browser
    .command('evaluate')
    .description('Evaluate JavaScript in current tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-e, --expression <js>', 'JavaScript expression to evaluate')
    .option('-f, --file <path>', 'Path to a .js file whose contents will be evaluated')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (opts.expression && opts.file) {
        console.error('Pass exactly one of --expression or --file');
        process.exit(1);
      }
      let expression: string;
      if (opts.file) {
        try {
          expression = fs.readFileSync(opts.file, 'utf8');
        } catch (err) {
          console.error(`Cannot read --file ${opts.file}: ${(err as Error).message}`);
          process.exit(1);
        }
      } else if (opts.expression) {
        expression = opts.expression;
      } else {
        console.error('Pass --expression <js> or --file <path>');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'evaluate',
        task,
        tabId: opts.tab,
        expr: expression,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(JSON.stringify(response.result, null, 2));
    });

  browser
    .command('ps')
    .description('List every browser/electron/tunnel process agents has tracked (alive or stale) — works without the daemon')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      const snapshots = listAllProfileSnapshots();
      // Cross-check against what's actually listening locally so we can
      // surface "port claimed by us but nothing is listening" (= leaked
      // cache file) and "port listening but not in our records" (= someone
      // else owns it; a new profile pointing here would collide).
      const portOwners = new Map<number, { pid: number; command: string }>();
      const conflicts: string[] = [];
      for (const s of snapshots) {
        const port = s.meta?.port;
        if (!port) continue;
        const occupant = getPortOccupant(port);
        if (!occupant) {
          if (s.pidAlive || s.tunnelAlive) {
            conflicts.push(`${s.name}: port ${port} marked active but nothing is listening`);
          }
          continue;
        }
        const ourPid = s.meta?.tunnelPid && s.meta.kind === 'tunnel'
          ? s.meta.tunnelPid
          : s.meta?.pid;
        if (ourPid && occupant.pid !== ourPid) {
          conflicts.push(
            `${s.name}: port ${port} listened on by ${occupant.command} (pid ${occupant.pid}) but our record says pid ${ourPid}`
          );
        }
        portOwners.set(port, occupant);
      }

      if (opts.json) {
        console.log(JSON.stringify({ snapshots, conflicts }, null, 2));
        return;
      }

      if (snapshots.length === 0) {
        console.log('No tracked browser state. Run `agents browser start --profile <name>` to spawn one.');
        return;
      }

      console.log('PROFILE                                  KIND      PID    TUNNEL  PORT   ALIVE  TASKS  OWNER');
      console.log('-----------------------------------------------------------------------------------------------');
      for (const s of snapshots) {
        const kind = s.meta?.kind ?? '-';
        const pid = s.meta?.pid ?? '-';
        const tunnelPid = s.meta?.tunnelPid ?? '-';
        const port = s.meta?.port ?? '-';
        const alive = aliveLabel(s);
        const owner = s.meta?.daemonPid
          ? `daemon${s.daemonAlive ? '' : '(dead)'}=${s.meta.daemonPid}`
          : '-';
        console.log(
          `${s.name.padEnd(40)} ${String(kind).padEnd(9)} ${String(pid).padEnd(6)} ${String(tunnelPid).padEnd(7)} ${String(port).padEnd(6)} ${alive.padEnd(6)} ${String(s.taskCount).padEnd(6)} ${owner}`
        );
      }

      if (conflicts.length > 0) {
        console.log('');
        console.log('Conflicts / leaks detected:');
        for (const c of conflicts) console.log(`  - ${c}`);
        console.log('');
        console.log('Run `agents browser stop --profile <name>` to clean up a specific profile, or restart the daemon to trigger the orphan reaper.');
      }
    });

  function aliveLabel(s: { pidAlive: boolean; tunnelAlive: boolean; meta: { kind?: string } | null }): string {
    const k = s.meta?.kind;
    if (k === 'tunnel') return s.tunnelAlive ? 'yes' : 'stale';
    return s.pidAlive ? 'yes' : 'stale';
  }

  browser
    .command('status')
    .description('Show running browser tasks')
    .option('-p, --profile <name>', 'Filter by profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      let response;
      try {
        response = await sendIPCRequest({
          action: 'status',
          profile: opts.profile,
        }, { autoStartDaemon: false });
      } catch (err) {
        if (err instanceof BrowserDaemonNotRunningError) {
          const message = formatBrowserDaemonNotRunningError();
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: message }));
          } else {
            console.error(message);
          }
          process.exit(1);
        }
        throw err;
      }

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.profiles ?? [], null, 2));
        return;
      }

      // Build flat list of tasks with profile context
      const allTasks: BrowserTask[] = [];
      for (const profile of response.profiles || []) {
        for (const task of profile.tasks) {
          allTasks.push({ task, profile });
        }
      }

      if (allTasks.length === 0) {
        // Show recent history instead
        const historyResponse = await sendIPCRequest({ action: 'history', limit: 5 });
        if (historyResponse.ok && historyResponse.history && historyResponse.history.length > 0) {
          console.log('No active tasks. Recent history:\n');
          console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
          console.log('-'.repeat(75));
          for (const h of historyResponse.history) {
            const domains = h.domains?.slice(0, 2).join(', ') || '-';
            const duration = formatDuration(h.endedAt - h.createdAt);
            const ended = formatAge(h.endedAt);
            console.log(
              h.profile.padEnd(15) +
                h.name.padEnd(18) +
                domains.slice(0, 20).padEnd(22) +
                duration.padEnd(10) +
                ended
            );
          }
          console.log('\nRun `browser history` for more.');
        } else {
          console.log('No browser tasks running');
        }
        return;
      }

      // Interactive picker for TTY, plain output otherwise
      if (isInteractiveTerminal()) {
        const picked = await browserTaskPicker({
          message: 'Browser tasks:',
          tasks: allTasks,
        });
        if (picked) {
          // Show tab list for the selected task
          const tabResponse = await sendIPCRequest({
            action: 'tab-list',
            task: picked.task.task.name,
          });
          if (tabResponse.ok && tabResponse.tabs) {
            console.log(`\nTabs for ${picked.task.task.name}:`);
            for (const tab of tabResponse.tabs) {
              console.log(`  ${tab.id}  ${tab.url}`);
            }
          }
        }
      } else {
        // Non-interactive: simple table output
        for (const profile of response.profiles || []) {
          const portLabel =
            profile.configuredPort && profile.configuredPort !== profile.port
              ? `port ${profile.port} (configured ${profile.configuredPort})`
              : `port ${profile.port}`;
          // pid 0 means the daemon attached to a browser we didn't launch — no
          // tracked pid. Render it as "attached" rather than the literal 0.
          const pidLabel = profile.pid ? `pid ${profile.pid}` : 'attached';
          console.log(`\n${profile.name} (${portLabel}, ${pidLabel})`);
          if (profile.tasks.length === 0) {
            console.log('  No active tasks');
          } else {
            console.log('  TASK'.padEnd(20) + 'TABS'.padEnd(6) + 'DOMAINS'.padEnd(25) + 'CREATED');
            for (const task of profile.tasks) {
              const age = formatAge(task.createdAt);
              const name = task.name || task.id;
              const domains = task.domains?.slice(0, 2).join(', ') || '-';
              console.log(
                '  ' +
                  name.padEnd(18) +
                  String(task.tabCount).padEnd(6) +
                  domains.slice(0, 23).padEnd(25) +
                  age
              );
            }
          }
        }
      }
    });

  browser
    .command('tasks')
    .description('List all browser tasks')
    .option('-p, --profile <name>', 'Filter by profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'status',
        profile: opts.profile,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      const allTasks: Array<{ profile: string; name: string; tabs: number; domains: string[]; created: number }> = [];
      for (const profile of response.profiles || []) {
        for (const task of profile.tasks) {
          allTasks.push({
            profile: profile.name,
            name: task.name || task.id,
            tabs: task.tabCount,
            domains: task.domains || [],
            created: task.createdAt,
          });
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(allTasks, null, 2));
        return;
      }

      if (allTasks.length === 0) {
        // Show recent history instead
        const historyResponse = await sendIPCRequest({ action: 'history', limit: 5 });
        if (historyResponse.ok && historyResponse.history && historyResponse.history.length > 0) {
          console.log('No active tasks. Recent history:\n');
          console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
          console.log('-'.repeat(75));
          for (const h of historyResponse.history) {
            const domains = h.domains?.slice(0, 2).join(', ') || '-';
            const duration = formatDuration(h.endedAt - h.createdAt);
            const ended = formatAge(h.endedAt);
            console.log(
              h.profile.padEnd(15) +
                h.name.padEnd(18) +
                domains.slice(0, 20).padEnd(22) +
                duration.padEnd(10) +
                ended
            );
          }
        } else {
          console.log('No active tasks');
        }
        return;
      }

      console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'TABS'.padEnd(6) + 'DOMAINS'.padEnd(22) + 'CREATED');
      console.log('-'.repeat(70));
      for (const t of allTasks) {
        const domains = t.domains.slice(0, 2).join(', ') || '-';
        console.log(
          t.profile.padEnd(15) +
            t.name.padEnd(18) +
            String(t.tabs).padEnd(6) +
            domains.slice(0, 20).padEnd(22) +
            formatAge(t.created)
        );
      }
    });

  browser
    .command('history')
    .description('Show recent browser task history')
    .option('-l, --limit <n>', 'Number of entries (default 10)', '10')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'history',
        limit: parseInt(opts.limit, 10),
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.history ?? [], null, 2));
        return;
      }

      if (!response.history || response.history.length === 0) {
        console.log('No browser task history');
        return;
      }

      console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
      console.log('-'.repeat(75));
      for (const h of response.history) {
        const domains = h.domains?.slice(0, 2).join(', ') || '-';
        const duration = formatDuration(h.endedAt - h.createdAt);
        const ended = formatAge(h.endedAt);
        console.log(
          h.profile.padEnd(15) +
            h.name.padEnd(18) +
            domains.slice(0, 20).padEnd(22) +
            duration.padEnd(10) +
            ended
        );
      }
    });

  browser
    .command('refs')
    .description('Get DOM refs for interactive elements')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--all', 'Include non-interactive elements')
    .option('-l, --limit <n>', 'Max elements (default 500)', '500')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'refs',
        task,
        tabId: opts.tab,
        interactive: !opts.all,
        limit: parseInt(opts.limit, 10),
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.nodes ?? [], null, 2));
        return;
      }

      console.log(response.refs);
    });

  browser
    .command('click <ref>')
    .description('Click an element by ref')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (ref: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'click',
        task,
        tabId: opts.tab,
        ref: parseInt(ref, 10),
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Clicked');
    });

  browser
    .command('type <ref>')
    .description('Type text into an element by ref')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .requiredOption('--text <text>', 'Text to type (use quotes for spaces/special chars)')
    .option('--clear', 'Clear editor content before typing')
    .action(async (ref: string, opts) => {
      const task = resolveTaskName(opts);
      const refNum = parseInt(ref, 10);
      if (!Number.isFinite(refNum)) {
        console.error(`<ref> must be an integer, got: ${ref}`);
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'type',
        task,
        tabId: opts.tab,
        ref: refNum,
        text: opts.text,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Typed');
    });

  browser
    .command('press <key>')
    .description('Press a key (Enter, Tab, Escape, etc)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (key: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'press',
        task,
        tabId: opts.tab,
        key,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Pressed');
    });

  browser
    .command('hover <ref>')
    .description('Hover over an element by ref')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (ref: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'hover',
        task,
        tabId: opts.tab,
        ref: parseInt(ref, 10),
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Hovered');
    });

  browser
    .command('scroll')
    .description('Scroll the page by pixel amount (negatives scroll up/left)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--dx <n>', 'Horizontal pixels (negative = left)', (v) => parseInt(v, 10), 0)
    .option('--dy <n>', 'Vertical pixels (negative = up)', (v) => parseInt(v, 10), 0)
    .option('-x, --at-x <x>', 'X coordinate to dispatch scroll from (default 0)', parseInt)
    .option('-y, --at-y <y>', 'Y coordinate to dispatch scroll from (default 0)', parseInt)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (!Number.isFinite(opts.dx) || !Number.isFinite(opts.dy)) {
        console.error('--dx and --dy must be integers');
        process.exit(1);
      }
      if (opts.dx === 0 && opts.dy === 0) {
        console.error('Pass --dx and/or --dy (at least one must be non-zero)');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'scroll',
        task,
        tabId: opts.tab,
        scrollX: opts.dx,
        scrollY: opts.dy,
        scrollAtX: opts.atX,
        scrollAtY: opts.atY,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Scrolled');
    });

  browser
    .command('upload')
    .description('Upload file(s) — supports hidden file inputs, drag-drop targets, and OS chooser interception')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-r, --ref <n>', 'Ref of the upload target element (file input or drop zone)', (v) => parseInt(v, 10))
    .option('--trigger <n>', 'Ref of a button that opens the OS file chooser (Pattern C)', (v) => parseInt(v, 10))
    .option('-f, --file <path...>', 'Absolute path(s) to file(s) to upload (repeatable)')
    .option('--drop', 'Force drag-drop pattern even if ref is an <input type=file>')
    .option('--input', 'Force file-input pattern (DOM.setFileInputFiles)')
    .option('--timeout <ms>', 'Timeout for chooser interception (Pattern C)', (v) => parseInt(v, 10))
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const files: string[] = opts.file ?? [];
      if (files.length === 0) {
        console.error('--file <path> is required (repeat for multiple files)');
        process.exit(1);
      }
      if (opts.ref === undefined && opts.trigger === undefined) {
        console.error('--ref <n> or --trigger <n> is required');
        process.exit(1);
      }
      if (opts.drop && opts.input) {
        console.error('--drop and --input are mutually exclusive');
        process.exit(1);
      }

      let mode: 'auto' | 'input' | 'drop' | 'chooser' = 'auto';
      if (opts.trigger !== undefined) mode = 'chooser';
      else if (opts.drop) mode = 'drop';
      else if (opts.input) mode = 'input';

      const response = await sendIPCRequest({
        action: 'upload',
        task,
        tabId: opts.tab,
        ref: opts.ref,
        trigger: opts.trigger,
        files,
        uploadMode: mode,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'} (${response.uploadMode})`);
    });

  // ─── Viewport & Device ───────────────────────────────────────────────────────

  const setCmd = browser.command('set').description('Set browser emulation options');

  setCmd
    .command('viewport <width> <height>')
    .description('Set viewport size')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-m, --mobile', 'Enable mobile emulation')
    .option('-s, --scale <factor>', 'Device scale factor', parseFloat)
    .action(async (width: string, height: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-viewport',
        task,
        tabId: opts.tab,
        width: parseInt(width, 10),
        height: parseInt(height, 10),
        mobile: opts.mobile,
        deviceScaleFactor: opts.scale,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Viewport set to ${width}x${height}${opts.mobile ? ' (mobile)' : ''}`);
    });

  setCmd
    .command('device <device-name>')
    .description('Emulate a device (iPhone 14, iPad, MacBook Pro)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (deviceName: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-device',
        task,
        tabId: opts.tab,
        deviceName,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Device set to ${deviceName}`);
    });

  browser
    .command('devices')
    .description('List available device presets')
    .action(async () => {
      const { DEVICES } = await import('../lib/browser/devices.js');
      console.log('Available devices:');
      for (const [name, desc] of Object.entries(DEVICES)) {
        console.log(`  ${name.padEnd(16)} ${desc.width}x${desc.height} @${desc.deviceScaleFactor}x${desc.mobile ? ' (mobile)' : ''}`);
      }
    });

  // ─── Console & Errors ────────────────────────────────────────────────────────

  browser
    .command('console')
    .description('Read console logs from a tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-l, --level <level>', 'Filter by level (log, info, warn, error)')
    .option('--clear', 'Clear logs after reading')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'console',
        task,
        tabId: opts.tab,
        level: opts.level,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (!response.logs || response.logs.length === 0) {
        console.log('No console logs');
        return;
      }

      for (const log of response.logs) {
        const prefix = `[${log.level.toUpperCase()}]`.padEnd(8);
        const loc = log.url ? ` (${log.url}${log.line ? `:${log.line}` : ''})` : '';
        console.log(`${prefix} ${log.text}${loc}`);
      }
    });

  browser
    .command('errors')
    .description('Read page errors from a tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--clear', 'Clear errors after reading')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'errors',
        task,
        tabId: opts.tab,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (!response.errors || response.errors.length === 0) {
        console.log('No errors');
        return;
      }

      for (const err of response.errors) {
        console.log(`[ERROR] ${err.message}`);
        if (err.stack) console.log(err.stack);
        if (err.url) console.log(`  at ${err.url}${err.line ? `:${err.line}` : ''}`);
        console.log();
      }
    });

  // ─── Network ─────────────────────────────────────────────────────────────────

  browser
    .command('requests')
    .description('Read captured network requests')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-f, --filter <text>', 'Filter URLs containing text')
    .option('--clear', 'Clear requests after reading')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'requests',
        task,
        tabId: opts.tab,
        filter: opts.filter,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (!response.requests || response.requests.length === 0) {
        console.log('No requests captured');
        return;
      }

      console.log('METHOD'.padEnd(8) + 'STATUS'.padEnd(8) + 'URL');
      console.log('-'.repeat(72));
      for (const req of response.requests) {
        const status = req.status ? String(req.status) : '...';
        console.log(`${req.method.padEnd(8)}${status.padEnd(8)}${req.url.slice(0, 100)}`);
      }
    });

  browser
    .command('logs <task>')
    .description('Read merged rush-app + rush-cli JSONL logs for a task')
    .option('--source <name>', 'Source to scope to: rush-app or rush-cli (default both)')
    .option('--lines <n>', 'Tail N entries (default 200; ignored when --since)', (v) => parseInt(v, 10))
    .option('--since <when>', 'Absolute timestamp or relative offset (e.g. 5m, 2h, 1d)')
    .option('--until <when>', 'Absolute timestamp or relative offset (e.g. 5m, 2h, 1d)')
    .option('--level <level>', 'Filter entries by level field')
    .option('--message <name>', 'Filter entries by exact message field')
    .option('--filter <text>', 'Filter entries whose JSON contains this substring')
    .option('-f, --follow', 'Follow mode (not yet implemented)')
    .action(async (task: string, opts) => {
      if (opts.follow) {
        process.stderr.write('follow mode not yet implemented; coming next pass\n');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'getAppLogs',
        task,
        source: opts.source,
        lines: opts.lines,
        since: opts.since,
        until: opts.until,
        appLevel: opts.level,
        message: opts.message,
        filter: opts.filter,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      const entries = response.appLogs ?? [];
      for (const entry of entries) {
        console.log(JSON.stringify(entry));
      }
    });

  browser
    .command('responsebody <url-pattern>')
    .description('Wait for and read a response body by URL pattern')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .option('--max-chars <n>', 'Max characters to return', parseInt)
    .action(async (urlPattern: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'response-body',
        task,
        tabId: opts.tab,
        urlPattern,
        timeout: opts.timeout,
        maxChars: opts.maxChars,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.body);
    });

  // ─── Wait ────────────────────────────────────────────────────────────────────

  browser
    .command('wait')
    .description('Wait for a condition')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--time <ms>', 'Wait for milliseconds')
    .option('--selector <css>', 'Wait for CSS selector to appear')
    .option('--url <pattern>', 'Wait for URL to match pattern')
    .option('--fn <js>', 'Wait for JS expression to return truthy')
    .option('--state <state>', 'Wait for load state (domcontentloaded, load, networkidle)')
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      let waitType: 'time' | 'selector' | 'url' | 'function' | 'load';
      let waitValue: string | number;

      if (opts.time) {
        waitType = 'time';
        waitValue = parseInt(opts.time, 10);
      } else if (opts.selector) {
        waitType = 'selector';
        waitValue = opts.selector;
      } else if (opts.url) {
        waitType = 'url';
        waitValue = opts.url;
      } else if (opts.fn) {
        waitType = 'function';
        waitValue = opts.fn;
      } else if (opts.state) {
        waitType = 'load';
        waitValue = opts.state;
      } else {
        console.error('One of --time, --selector, --url, --fn, or --state required');
        process.exit(1);
      }

      const response = await sendIPCRequest({
        action: 'wait',
        task,
        tabId: opts.tab,
        waitType,
        waitValue,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Wait condition met');
    });

  // ─── Downloads ───────────────────────────────────────────────────────────────

  browser
    .command('download')
    .description('Set download directory for a task')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .requiredOption('-p, --path <dir>', 'Download directory path')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-download-path',
        task,
        tabId: opts.tab,
        downloadPath: opts.path,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Download path set to ${opts.path}`);
    });

  // ─── Recording ─────────────────────────────────────────────────────────────

  const record = browser.command('record').description('Record a video of the page');

  record
    .command('start')
    .description('Start recording — auto-saved under sessions/<task>/recordings/. Bounded by --fps, --duration, --max-mb.')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--fps <n>', 'Frames per second (1–30, default 5)', (v) => parseInt(v, 10))
    .option('--duration <sec>', 'Hard duration cap in seconds (default 60)', (v) => parseInt(v, 10))
    .option('--max-mb <mb>', 'Stop when output exceeds this many MB (default 25)', (v) => parseInt(v, 10))
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'record-start',
        task,
        tabId: opts.tab,
        fps: opts.fps,
        duration: opts.duration,
        maxMb: opts.maxMb,
      });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      // stdout: path (for capture into a variable). stderr: human commentary.
      console.log(response.path);
      console.error(
        `Recording task "${task}" at ${response.fps} fps (cap ${response.durationCapSec}s / ${response.maxMb} MB) → ${response.path}`
      );
      console.error('Stop with: agents browser record stop');
    });

  record
    .command('stop')
    .description('Stop an in-progress recording')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({ action: 'record-stop', task });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      console.log(response.path);
      const size = humanizeBytes(response.bytes);
      const seconds = ((response.durationMs ?? 0) / 1000).toFixed(1);
      console.error(`Saved recording to ${response.path} (${size}, ${seconds}s, stopped: ${response.stopReason})`);
    });

  browser
    .command('waitdownload')
    .description('Wait for a download to complete')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'wait-download',
        task,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Downloaded: ${response.downloadPath}`);
    });
}

function collect(val: string, memo: string[]): string[] {
  memo.push(val);
  return memo;
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function humanizeBytes(n: number | undefined): string {
  if (n === undefined) return 'unknown size';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `${hours}h ${mm}m` : `${hours}h`;
}
