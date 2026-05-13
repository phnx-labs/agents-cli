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
  type BrowserProfile,
} from '../lib/browser/profiles.js';
import { findBrowserPath, getPortOccupant } from '../lib/browser/chrome.js';
import { discoverBrowserWsUrl, verifyBrowserIdentity } from '../lib/browser/cdp.js';
import { parseTargetFilter } from '../lib/browser/service.js';
import { sendIPCRequest } from '../lib/browser/ipc.js';
import { browserTaskPicker, type BrowserTask } from './browser-picker.js';
import { isInteractiveTerminal } from './utils.js';

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command('browser')
    .description('Browser automation via CDP');

  registerProfilesCommands(browser);
  registerTaskCommands(browser);
}

export function registerBrowserSubcommands(program: Command): void {
  registerProfilesCommands(program);
  registerTaskCommands(program);
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
          const endpoints = p.endpoints.join(', ');
          const desc = (p.description ?? '').slice(0, 36).padEnd(38);
          console.log(p.name.padEnd(20) + (p.browser || '-').padEnd(12) + desc + endpoints);
        }
      } else {
        console.log('NAME'.padEnd(20) + 'BROWSER'.padEnd(12) + 'ENDPOINTS');
        console.log('-'.repeat(72));
        for (const p of allProfiles) {
          const endpoints = p.endpoints.join(', ');
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
    .option('--window <WxH>', 'Window size, e.g. 1512x982')
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

      // Viewport is mandatory — default to 1512x982 if --window is not provided
      let viewport: { width: number; height: number; x?: number; y?: number } = {
        width: 1512,
        height: 982,
      };
      if (opts.window) {
        const m = String(opts.window).match(/^(\d+)x(\d+)$/);
        if (!m) {
          console.error('--window must be WxH, e.g. 1512x982');
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
      console.log(`Endpoints:`);
      for (const e of profile.endpoints) {
        console.log(`  - ${e}`);
      }
      if (profile.secrets) console.log(`Secrets: ${profile.secrets}`);
      if (profile.chrome?.headless) console.log(`Headless: true`);
    });

  profiles
    .command('delete <name>')
    .description('Delete a browser profile')
    .action(async (name: string) => {
      await deleteProfile(name);
      console.log(`Deleted profile: ${name}`);
    });

  profiles
    .command('launch <name>')
    .description('Start (or attach to) the profile\'s browser without creating a task')
    .action(async (name: string) => {
      const profile = await getProfile(name);
      if (!profile) {
        console.error(`Profile "${name}" not found`);
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'launch-profile',
        profile: name,
      });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      const pidLabel = response.pid ? `pid ${response.pid}` : 'attached';
      console.log(`Launched "${name}" on port ${response.port} (${pidLabel})`);
      console.log(`Next: agents browser start --profile ${name} --url <url>`);
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

      // 2. Configured port: free, or already serving the expected browser?
      const port = extractConfiguredPort(profile);
      let attachingToExistingBrowser = false;
      if (port === undefined) {
        checks.push({ label: 'port', ok: true, detail: 'no port in endpoint' });
      } else {
        const occupant = getPortOccupant(port);
        if (!occupant) {
          checks.push({ label: 'port', ok: true, detail: `${port} is free` });
        } else {
          try {
            const { browser } = await discoverBrowserWsUrl(port);
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
              detail: 'Local State is empty — run `agents browser profiles prime ' + name + '`',
            });
          }
        } else {
          checks.push({
            label: 'onboarding',
            ok: false,
            detail: 'Not primed yet — run `agents browser profiles prime ' + name + '`',
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

  profiles
    .command('prime <name>')
    .description('Launch the profile so you can complete first-run onboarding interactively')
    .action(async (name: string) => {
      const profile = await getProfile(name);
      if (!profile) {
        console.error(`Profile "${name}" not found`);
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'launch-profile',
        profile: name,
      });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      const pidLabel = response.pid ? `pid ${response.pid}` : 'attached';
      console.log(`Launched "${name}" on port ${response.port} (${pidLabel}).`);
      console.log('');
      console.log('Finish any first-run / onboarding screens in the browser window');
      console.log('(welcome, profile setup, default-browser prompt, sign-in, etc.).');
      console.log('Once you reach a normal browsing surface, this profile is primed');
      console.log('— its user-data-dir persists across runs, so you only do this once.');
      console.log('');
      console.log(`Next: agents browser start --profile ${name} --url <url>`);
    });
}

function registerTaskCommands(browser: Command): void {
  browser
    .command('start')
    .description('Start a browser task with a profile')
    .requiredOption('-p, --profile <name>', 'Browser profile to use')
    .option('-t, --task <name>', 'Task name (auto-generated if omitted)')
    .option('-u, --url <url>', 'Open URL in first tab')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'start',
        profile: opts.profile,
        taskName: opts.task,
        url: opts.url,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (opts.url && response.tabId) {
        console.log(`Started task "${response.task}" with tab ${response.tabId}`);
      } else {
        console.log(`Started task "${response.task}"`);
      }
    });

  browser
    .command('done <task>')
    .description('Complete a task and close its tabs')
    .action(async (task: string) => {
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
    .command('stop <task>')
    .description('Stop a browser task and close its tabs')
    .action(async (task: string) => {
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
    .command('navigate <task> <url>')
    .description('Navigate current tab to URL (creates tab if none exist)')
    .option('-p, --profile <name>', 'Browser profile (optional if task is unique)')
    .action(async (task: string, url: string, opts) => {
      const response = await sendIPCRequest({
        action: 'navigate',
        task,
        url,
        profile: opts.profile,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Navigated ${response.tabId} to ${url}`);
    });

  // Tab subcommand group
  const tab = browser.command('tab').description('Manage tabs');

  tab
    .command('add <task> <url>')
    .description('Open URL in new tab (becomes current)')
    .option('-p, --profile <name>', 'Browser profile')
    .action(async (task: string, url: string, opts) => {
      const response = await sendIPCRequest({
        action: 'tab-add',
        task,
        url,
        profile: opts.profile,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Opened tab ${response.tabId}: ${url}`);
    });

  tab
    .command('focus <task> <tabId>')
    .description('Switch to tab (by ID, prefix, or URL substring)')
    .action(async (task: string, tabId: string) => {
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
    .command('close <task> [tabId]')
    .description('Close tab(s) — omit tabId to close all')
    .action(async (task: string, tabId: string | undefined) => {
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

  tab
    .command('list <task>')
    .description('List tabs for a task')
    .option('--json', 'Output machine-readable JSON')
    .action(async (task: string, opts) => {
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
    .command('screenshot <task> [tabId]')
    .description('Take a screenshot')
    .option('-o, --output <path>', 'Output path')
    .action(async (task: string, tabId: string | undefined, opts) => {
      const response = await sendIPCRequest({
        action: 'screenshot',
        task,
        tabId,
        path: opts.output,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.path);
    });

  browser
    .command('evaluate <task> <expression>')
    .description('Evaluate JavaScript in current tab')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, expression: string, opts) => {
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
    .command('status')
    .description('Show running browser tasks')
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
    .command('refs <task>')
    .description('Get DOM refs for interactive elements')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--all', 'Include non-interactive elements')
    .option('-l, --limit <n>', 'Max elements (default 500)', '500')
    .option('--json', 'Output machine-readable JSON')
    .action(async (task: string, opts) => {
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
    .command('click <task> <ref>')
    .description('Click an element by ref')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, ref: string, opts) => {
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
    .command('type <task> <ref> <text>')
    .description('Type text into an element by ref')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--clear', 'Clear editor content before typing')
    .action(async (task: string, ref: string, text: string, opts) => {
      const response = await sendIPCRequest({
        action: 'type',
        task,
        tabId: opts.tab,
        ref: parseInt(ref, 10),
        text,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Typed');
    });

  browser
    .command('press <task> <key>')
    .description('Press a key (Enter, Tab, Escape, etc)')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, key: string, opts) => {
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
    .command('hover <task> <ref>')
    .description('Hover over an element by ref')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, ref: string, opts) => {
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
    .command('scroll <task> <deltaX> <deltaY>')
    .description('Scroll the page by pixel amount')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-x, --at-x <x>', 'X coordinate to dispatch scroll from (default 0)', parseInt)
    .option('-y, --at-y <y>', 'Y coordinate to dispatch scroll from (default 0)', parseInt)
    .action(async (task: string, deltaX: string, deltaY: string, opts) => {
      const response = await sendIPCRequest({
        action: 'scroll',
        task,
        tabId: opts.tab,
        scrollX: parseInt(deltaX, 10),
        scrollY: parseInt(deltaY, 10),
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
    .command('upload <task>')
    .description('Upload file(s) — supports hidden file inputs, drag-drop targets, and OS chooser interception')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-r, --ref <n>', 'Ref of the upload target element (file input or drop zone)', (v) => parseInt(v, 10))
    .option('--trigger <n>', 'Ref of a button that opens the OS file chooser (Pattern C)', (v) => parseInt(v, 10))
    .option('-f, --file <path...>', 'Absolute path(s) to file(s) to upload (repeatable)')
    .option('--drop', 'Force drag-drop pattern even if ref is an <input type=file>')
    .option('--input', 'Force file-input pattern (DOM.setFileInputFiles)')
    .option('--timeout <ms>', 'Timeout for chooser interception (Pattern C)', (v) => parseInt(v, 10))
    .action(async (task: string, opts) => {
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
    .command('viewport <task> <width> <height>')
    .description('Set viewport size')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-m, --mobile', 'Enable mobile emulation')
    .option('-s, --scale <factor>', 'Device scale factor', parseFloat)
    .action(async (task: string, width: string, height: string, opts) => {
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
    .command('device <task> <device-name>')
    .description('Emulate a device (iPhone 14, iPad, MacBook Pro)')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (task: string, deviceName: string, opts) => {
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
    .command('console <task>')
    .description('Read console logs from a tab')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-l, --level <level>', 'Filter by level (log, info, warn, error)')
    .option('--clear', 'Clear logs after reading')
    .action(async (task: string, opts) => {
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
    .command('errors <task>')
    .description('Read page errors from a tab')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--clear', 'Clear errors after reading')
    .action(async (task: string, opts) => {
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
    .command('requests <task>')
    .description('Read captured network requests')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-f, --filter <text>', 'Filter URLs containing text')
    .option('--clear', 'Clear requests after reading')
    .action(async (task: string, opts) => {
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
    .command('responsebody <task> <url-pattern>')
    .description('Wait for and read a response body by URL pattern')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .option('--max-chars <n>', 'Max characters to return', parseInt)
    .action(async (task: string, urlPattern: string, opts) => {
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
    .command('wait <task>')
    .description('Wait for a condition')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--time <ms>', 'Wait for milliseconds')
    .option('--selector <css>', 'Wait for CSS selector to appear')
    .option('--url <pattern>', 'Wait for URL to match pattern')
    .option('--fn <js>', 'Wait for JS expression to return truthy')
    .option('--state <state>', 'Wait for load state (domcontentloaded, load, networkidle)')
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .action(async (task: string, opts) => {
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
    .command('download <task>')
    .description('Set download directory for a task')
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .requiredOption('-p, --path <dir>', 'Download directory path')
    .action(async (task: string, opts) => {
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

  browser
    .command('waitdownload <task>')
    .description('Wait for a download to complete')
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .action(async (task: string, opts) => {
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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `${hours}h ${mm}m` : `${hours}h`;
}
