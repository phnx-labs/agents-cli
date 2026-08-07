import { describe, it, expect } from 'vitest';

// win32: Claude projects path joins absolute cwd with colons (RUSH-2215).
const describeLive = process.platform === 'win32' ? describe.skip : describe;
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  buildResumeCommand,
  resumeSpawnInvocation,
  resolveSessionQuery,
  buildSessionDescription,
  fleetCandidatesByQuery,
  metadataResolveOutcome,
  metadataResolveForwardedArgs,
  isDefinitiveMatch,
  selectorAllowsEarlyExit,
  fleetNotFoundMessage,
  mergeToolSearchEnvelopes,
  mergeToolProgramCountEnvelopes,
  toolOriginSessions,
  toolSearchFleetSortError,
  toolSearchForwardedArgs,
  matchesLiveStatus,
  isRunningLiveSession,
  resolveSessionAgentName,
  requestedLiveStatuses,
  parseInstalledAgentVersionQuery,
} from './sessions.js';
import { remoteAgentsJsonCommand } from '../lib/remote-agents-json.js';
import { NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import { parseRemoteList } from '../lib/session/remote-list.js';
import { needsWindowsShell, composeWin32CommandLine } from '../lib/platform/index.js';
import type { SessionMeta } from '../lib/session/types.js';
import type { ActiveSession } from '../lib/session/active.js';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
// Run the CLI as `node --import <tsx loader> src/index.ts`: spawning `node`
// (always on PATH, no .cmd shell launcher) with the tsx ESM loader resolved to
// an absolute file URL keeps tsx loadable regardless of the spawn cwd (which we
// point at the project dir). Avoids both the Windows `tsx.cmd`-needs-a-shell
// problem and shell:true arg-concatenation (which would split multi-word query
// args like "prompt text").
const tsxLoaderUrl = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

describe('session harness name resolution', () => {
  it('shares canonical aliases and typo correction with focus selectors', () => {
    expect(resolveSessionAgentName('claude-code')).toBe('claude');
    expect(resolveSessionAgentName('cladue')).toBe('claude');
    expect(resolveSessionAgentName('GROK')).toBe('grok');
    expect(resolveSessionAgentName('not-a-harness')).toBeNull();
  });
});

describe('positional installed agent version filters', () => {
  const installed = (agent: string) => agent === 'claude' ? ['2.1.181'] : ['0.146.0'];

  it('recognizes an exact installed agent@version pair', () => {
    expect(parseInstalledAgentVersionQuery('claude@2.1.181', installed)).toBe('claude@2.1.181');
    expect(parseInstalledAgentVersionQuery('CODEX@0.146.0', installed)).toBe('codex@0.146.0');
  });

  it('leaves unknown, uninstalled, and prose queries on the free-text path', () => {
    expect(parseInstalledAgentVersionQuery('claude@9.9.9', installed)).toBeUndefined();
    expect(parseInstalledAgentVersionQuery('cladue@2.1.181', installed)).toBeUndefined();
    expect(parseInstalledAgentVersionQuery('project@2026', installed)).toBeUndefined();
    expect(parseInstalledAgentVersionQuery('claude@2.1.181 notes', installed)).toBeUndefined();
  });
});

describeLive('live session status flags', () => {
  const row = (over: Partial<ActiveSession>): ActiveSession => ({
    context: 'terminal', kind: 'codex', status: 'running', ...over,
  });

  it('maps every convenience flag and deduplicates --orphan/--orphaned', () => {
    expect(requestedLiveStatuses({
      working: true, idle: true, waiting: true, orphan: true, orphaned: true,
      crashed: true, closed: true, abandoned: true, queued: true, unknown: true,
    })).toEqual([
      'working', 'idle', 'waiting', 'orphaned', 'crashed', 'closed', 'abandoned', 'queued', 'unknown',
    ]);
  });

  it('distinguishes working from idle and waiting activity', () => {
    expect(matchesLiveStatus(row({ activity: 'working' }), 'working')).toBe(true);
    expect(matchesLiveStatus(row({ status: 'idle', activity: 'idle' }), 'working')).toBe(false);
    expect(matchesLiveStatus(row({ status: 'input_required', activity: 'waiting_input' }), 'waiting')).toBe(true);
  });

  it('matches lifecycle states exactly', () => {
    for (const status of ['idle', 'orphaned', 'crashed', 'closed', 'abandoned', 'queued', 'unknown'] as const) {
      expect(matchesLiveStatus(row({ status }), status)).toBe(true);
    }
  });

  it('distinguishes active rows from dead rows retained for recovery filters', () => {
    // A real OS process is active only once it's positively located: a
    // machine, a positive pid, AND verified liveness (RUSH-2336).
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    expect(isRunningLiveSession(row({ status: 'orphaned', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    // A live-but-stuck abandoned row still qualifies — the pid is genuinely alive.
    expect(isRunningLiveSession(row({ status: 'abandoned', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    expect(isRunningLiveSession(row({ status: 'closed', machine: 'zion', pid: 111, pidAlive: false }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'crashed', machine: 'zion', pid: 111, pidAlive: true }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'abandoned', machine: 'zion', pid: 111, pidAlive: false }))).toBe(false);
    // Dispatched but not yet started — only the explicit --queued view shows it.
    expect(isRunningLiveSession(row({ status: 'queued', machine: 'zion', pid: 111, pidAlive: true }))).toBe(false);
    // Unverified liveness (unknown pidAlive, no machine, or no pid at all) never
    // counts as active, even when the status itself reads "running".
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pid: 111 }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'running', pid: 111, pidAlive: true }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pidAlive: true }))).toBe(false);
    // A cloud row has no local pid at all — it's active on the provider's word.
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'running', cloudProvider: 'rush', cloudTaskId: 't1' }))).toBe(true);
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'queued', cloudProvider: 'rush', cloudTaskId: 't1' }))).toBe(false);
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'running', cloudProvider: 'rush' }))).toBe(false);
  });

  it('routes aliases, unions, and the waiting exit gate through the real CLI', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-flags-'));
    const cwd = path.join(tempHome, 'work', 'status-fixture');
    const liveSessionId = 'abcd1111-1111-4111-8111-111111111111';
    const crashedSessionId = 'abcd2222-2222-4222-8222-222222222222';
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    try {
      writeUpdateCache(tempHome);
      const projectKey = cwd.replace(/[/.]/g, '-');
      writeClaudeSession(
        tempHome,
        projectKey,
        liveSessionId,
        cwd,
        'Waiting for the user to choose',
        new Date(Date.now() - 15 * 60_000).toISOString(),
      );
      fs.appendFileSync(
        path.join(tempHome, '.claude', 'projects', projectKey, `${liveSessionId}.jsonl`),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(Date.now() - 15 * 60_000).toISOString(),
          sessionId: liveSessionId,
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'ask-status-filter',
              name: 'AskUserQuestion',
              input: {
                questions: [{
                  question: 'Choose the next step',
                  header: 'Scope',
                  options: [
                    { label: 'Continue', description: 'Keep working' },
                    { label: 'Stop', description: 'End the session' },
                  ],
                }],
              },
            }],
          },
        }) + '\n',
        'utf-8',
      );
      const registry = path.join(tempHome, '.agents', '.cache', 'terminals', 'live-terminals.json');
      fs.mkdirSync(path.dirname(registry), { recursive: true });
      fs.writeFileSync(registry, JSON.stringify({
        'stale-window': {
          at: new Date(Date.now() - 11 * 60_000).toISOString(),
          entries: [
            { sessionId: liveSessionId, pid: sleeper.pid, kind: 'claude', cwd, startedAtMs: Date.now() },
            { sessionId: crashedSessionId, pid: 2_000_000_003, kind: 'claude', cwd, startedAtMs: Date.now() },
          ],
        },
      }));

      const orphan = runAgents(['sessions', '--orphan', '--json', '--local'], cwd, tempHome);
      const orphaned = runAgents(['sessions', '--orphaned', '--json', '--local'], cwd, tempHome);
      expect(orphan.status, orphan.stderr).toBe(0);
      expect(orphaned.status, orphaned.stderr).toBe(0);
      expect(JSON.parse(orphan.stdout).map((row: ActiveSession) => row.sessionId)).toContain(liveSessionId);
      expect(JSON.parse(orphaned.stdout)).toEqual(JSON.parse(orphan.stdout));

      const union = runAgents(['sessions', '--orphan', '--crashed', '--json', '--local'], cwd, tempHome);
      expect(union.status, union.stderr).toBe(0);
      const unionIds = JSON.parse(union.stdout).map((row: ActiveSession) => row.sessionId);
      expect(unionIds).toContain(liveSessionId);
      expect(unionIds).toContain(crashedSessionId);

      const waitingUnion = runAgents(['sessions', '--waiting', '--orphan', '--json', '--local'], cwd, tempHome);
      expect(waitingUnion.status).toBe(1);
      expect(JSON.parse(waitingUnion.stdout).map((row: ActiveSession) => row.sessionId)).toContain(liveSessionId);

      const active = runAgents(['sessions', '--active', '--json', '--local'], cwd, tempHome);
      expect(active.status, active.stderr).toBe(0);
      const activeIds = JSON.parse(active.stdout).map((row: ActiveSession) => row.sessionId);
      expect(activeIds).toContain(liveSessionId);
      expect(activeIds).not.toContain(crashedSessionId);
    } finally {
      sleeper.kill('SIGTERM');
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('toolSearchForwardedArgs', () => {
  it('removes coordinator device flags and forces a whole-index local peer query', () => {
    const argv = [
      process.execPath, 'agents', 'sessions', '--include', 'tools',
      '--query', 'program:git', '--device', 'peer-one', '--fleet', '--json',
    ];
    expect(toolSearchForwardedArgs(argv, ['peer-one'])).toEqual([
      'sessions', '--include', 'tools', '--query', 'program:git', '--json', '--all', '--local',
    ]);
  });
});

describe('toolSearchFleetSortError', () => {
  it('rejects cost and duration sorts only when tool evidence spans devices', () => {
    expect(toolSearchFleetSortError('cost', true)).toContain('only --sort recent');
    expect(toolSearchFleetSortError('duration', true)).toContain('only --sort recent');
    expect(toolSearchFleetSortError('recent', true)).toBeUndefined();
    expect(toolSearchFleetSortError('cost', false)).toBeUndefined();
  });
});

describe('fleet tool query origin partitioning', () => {
  it('sums occurrences, containing calls, sessions, and coverage across machines', () => {
    const make = (machine: string, occurrences: number, complete = true) => ({
      schemaVersion: 1 as const,
      kind: 'tool-program-count' as const,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { program: 'git', semantics: 'static-program-occurrences-v1' as const },
      coverage: { indexedFiles: 1, indexedCalls: 2, skippedFiles: 0, limitedFiles: 0, remainingFiles: complete ? 0 : 1, complete },
      totals: { occurrences, toolCalls: occurrences - 1, sessions: 1 },
      machines: [{
        machine,
        coverage: { indexedFiles: 1, indexedCalls: 2, skippedFiles: 0, limitedFiles: 0, remainingFiles: complete ? 0 : 1, complete },
        totals: { occurrences, toolCalls: occurrences - 1, sessions: 1 },
      }],
    });
    expect(mergeToolProgramCountEnvelopes(make('one', 3), [make('two', 2, false)]))
      .toMatchObject({
        coverage: { indexedFiles: 2, complete: false },
        totals: { occurrences: 5, toolCalls: 3, sessions: 2 },
        machines: [{ machine: 'one' }, { machine: 'two' }],
      });
  });

  it('keeps synced mirrors out of an origin device fleet partition', () => {
    const local = { id: 'local', machine: 'one' } as SessionMeta;
    const mirror = { id: 'mirror', machine: 'two' } as SessionMeta;
    expect(toolOriginSessions([local, mirror], 'one', true)).toEqual([local]);
    expect(toolOriginSessions([local, mirror], 'one', false)).toEqual([local, mirror]);
  });

  it('deduplicates evidence for the same origin session returned through two peers', () => {
    const coverage = {
      indexedFiles: 1, indexedCalls: 1, skippedFiles: 0,
      limitedFiles: 0, remainingFiles: 0, complete: true,
    };
    const make = (timestamp: string) => ({
      schemaVersion: 1 as const,
      generatedAt: timestamp,
      query: { clauses: ['program:git'] },
      coverage,
      sessions: [{
        id: 'same', shortId: 'same', agent: 'codex', machine: 'origin-one', timestamp,
        calls: [],
      }],
    });
    expect(mergeToolSearchEnvelopes(make('2026-08-03T00:00:00Z'), [
      make('2026-08-03T00:00:01Z'),
    ]).sessions).toHaveLength(1);
  });
});

function writeUpdateCache(tempHome: string): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')
  ) as { version: string };

  fs.mkdirSync(path.join(tempHome, '.agents', '.cache'), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, '.agents', '.cache', '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: packageJson.version }),
    'utf-8'
  );
  // ensureInitialized() checks for ~/.agents/.system/.git to confirm setup.
  fs.mkdirSync(path.join(tempHome, '.agents', '.system', '.git'), { recursive: true });
}

function writeClaudeSession(
  tempHome: string,
  projectKey: string,
  sessionId: string,
  cwd: string,
  content: string,
  timestamp: string,
): void {
  fs.mkdirSync(cwd, { recursive: true });
  const sessionsDir = path.join(tempHome, '.claude', 'projects', projectKey);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'user',
      timestamp,
      cwd,
      sessionId,
      version: '2.1.110',
      gitBranch: 'main',
      message: { role: 'user', content },
    }) + '\n',
    'utf-8'
  );
}

function writeCodexSession(
  tempHome: string,
  sessionId: string,
  cwd: string,
  prompt: string,
  timestamp: string,
): void {
  fs.mkdirSync(cwd, { recursive: true });
  const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '04', '17');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const filePath = path.join(
    sessionsDir,
    `rollout-${timestamp.replace(/[:.]/g, '-')}-${sessionId}.jsonl`
  );

  const lines = [
    JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp,
        cwd,
        originator: 'codex_cli_rs',
        cli_version: '0.113.0',
        source: 'cli',
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<permissions instructions>\nFilesystem sandboxing.\n</permissions instructions>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp/project</cwd>\n  <shell>zsh</shell>\n</environment_context>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<collaboration_mode># Collaboration Mode: Default\n</collaboration_mode>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nDo work.\n</INSTRUCTIONS>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Looking into it now.' }],
      },
    }),
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function writeGeminiSession(
  tempHome: string,
  sessionId: string,
  cwd: string,
  prompt: string,
  timestamp: string,
  version = '0.29.5',
): void {
  const versionHome = path.join(tempHome, '.agents', '.history', 'versions', 'gemini', version, 'home');
  const geminiHome = path.join(versionHome, '.gemini');
  const projectHash = crypto.createHash('sha256').update(cwd).digest('hex');
  const chatsDir = path.join(geminiHome, 'tmp', projectHash, 'chats');

  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(tempHome, '.gemini')), { recursive: true });

  const activeGeminiHome = path.join(tempHome, '.gemini');
  if (!fs.existsSync(activeGeminiHome)) {
    fs.symlinkSync(geminiHome, activeGeminiHome);
  }

  fs.writeFileSync(
    path.join(geminiHome, 'projects.json'),
    JSON.stringify({ projects: [cwd] }),
    'utf-8'
  );

  fs.writeFileSync(
    path.join(chatsDir, `session-${timestamp.replace(/[:.]/g, '-')}-${sessionId.slice(0, 8)}.json`),
    JSON.stringify({
      sessionId,
      projectHash,
      startTime: timestamp,
      lastUpdated: timestamp,
      messages: [
        {
          id: `${sessionId}-user`,
          timestamp,
          type: 'user',
          content: [{ text: prompt }],
        },
        {
          id: `${sessionId}-assistant`,
          timestamp,
          type: 'gemini',
          content: 'Investigating now.',
          model: 'gemini-3-flash-preview',
          tokens: { total: 1234 },
        },
      ],
    }, null, 2),
    'utf-8'
  );
}

function writeOpenClawSetup(tempHome: string, version = '2026.3.8'): string {
  const managedHome = path.join(tempHome, '.agents', '.history', 'versions', 'openclaw', version, 'home', '.openclaw');
  fs.mkdirSync(managedHome, { recursive: true });

  const activeHome = path.join(tempHome, '.openclaw');
  fs.mkdirSync(path.dirname(activeHome), { recursive: true });
  if (!fs.existsSync(activeHome)) {
    fs.symlinkSync(managedHome, activeHome);
  }

  const managedWorkspace = path.join(managedHome, 'sergey');
  fs.mkdirSync(managedWorkspace, { recursive: true });
  fs.writeFileSync(
    path.join(managedHome, 'openclaw.json'),
    JSON.stringify({
      agents: {
        list: [
          { id: 'sergey', workspace: path.join(activeHome, 'sergey') },
        ],
      },
    }, null, 2),
    'utf-8'
  );

  const binDir = path.join(tempHome, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const openclawBin = path.join(binDir, 'openclaw');
  fs.writeFileSync(
    openclawBin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "openclaw/${version}"
  exit 0
fi

if [ "$1" = "channels" ] && [ "$2" = "status" ]; then
  echo "- Telegram sergey (Sergey): enabled, configured, running, out:2h ago, mode:polling, token:config"
  exit 0
fi

if [ "$1" = "cron" ] && [ "$2" = "list" ]; then
  echo "ID NAME SCHEDULE NEXT LAST STATUS TARGET AGENT MODEL"
  echo "12345678-1234-1234-1234-123456789abc sergey-hourly  cron */30 * * * * in 7h  48m ago  ok  isolated  sergey  -"
  exit 0
fi

exit 1
`,
    'utf-8'
  );
  fs.chmodSync(openclawBin, 0o755);

  return path.join(activeHome, 'sergey');
}

function runAgents(args: string[], cwd: string, home: string, envOverrides: Record<string, string> = {}) {
  return spawnSync('node', ['--import', tsxLoaderUrl, cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      // os.homedir() (used via homeDir() in discovery) reads USERPROFILE on
      // Windows and ignores HOME, so set both to redirect the home to tempHome.
      USERPROFILE: home,
      PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
      // Some fixtures place files at $HOME/.agents/versions/<agent>/<ver>/ as
      // legacy / synthetic state. The bootstrap-time migration would otherwise
      // move those into ~/.agents-system/, breaking workspace-scoped lookups.
      AGENTS_SKIP_MIGRATION: '1',
      NODE_NO_WARNINGS: '1',
      ...envOverrides,
    },
    encoding: 'utf-8',
  });
}

interface SessionResolverSshPeer {
  target: string;
  fixture: ChildProcess;
  socket: string;
  proofFile: string;
  /** The test's temp home — every process of this test carries it in argv. */
  home: string;
}

/**
 * Temp base for the ssh-peer tests. The production ControlPath is
 * `<home>/.agents/.cache/ssh/cm-%C`, and ssh appends a ~18-char listener
 * suffix — under macOS CI's deep TMPDIR (/var/folders/<30 chars>/T/sr-XXXXXX)
 * that blows past the 104-byte sun_path limit and every peer test fails at
 * ControlMaster startup. `/tmp` resolves to /private/tmp (12 chars), keeping
 * the full socket path under the limit. Linux paths are short already.
 */
const sshPeerTmpBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir();

/** Start the real ssh2 peer and graft its ephemeral TCP listener onto the exact
 * default-port OpenSSH ControlPath the production parent will look up. */
async function startSessionResolverSshPeer(
  mode: 'old-peer' | 'malformed',
  tempHome: string,
): Promise<SessionResolverSshPeer> {
  const hostKey = path.join(tempHome, 'fixture-host-key');
  const peerHome = path.join(tempHome, 'peer-home');
  const username = `srp-${crypto.randomBytes(16).toString('hex')}`;
  const target = `${username}@127.0.0.1`;
  const proofFile = path.join(tempHome, `${mode}-proof.txt`);
  const expectedCommand = remoteAgentsJsonCommand(
    metadataResolveForwardedArgs('abcd7777', {}),
    NO_FANOUT_ENV,
  );
  const controlPathTemplate = path.join(tempHome, '.agents', '.cache', 'ssh', 'cm-%C');
  fs.mkdirSync(path.dirname(controlPathTemplate), { recursive: true, mode: 0o700 });
  writeUpdateCache(peerHome);

  const keygen = spawnSync('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-N', '', '-f', hostKey], {
    encoding: 'utf-8',
  });
  if (keygen.status !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr}`);

  if (mode === 'old-peer') {
    const oldVersion = '1.20.88';
    const preflight = spawnSync(
      'npx',
      ['-y', '-p', `@phnx-labs/agents-cli@${oldVersion}`, 'agents', '--version'],
      {
        encoding: 'utf-8',
        env: { ...process.env, npm_config_cache: path.join(peerHome, 'npm-cache') },
        timeout: 60_000,
      },
    );
    if (preflight.status !== 0 || preflight.stdout.trim() !== oldVersion) {
      throw new Error(`old peer preflight failed: status=${preflight.status}; stdout=${preflight.stdout}; stderr=${preflight.stderr}`);
    }
  }

  const fixture = spawn(process.execPath, [path.join(repoRoot, 'src', 'commands', 'testdata', 'session-resolver-ssh-peer.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SRP_MODE: mode,
      SRP_HOST_KEY: hostKey,
      SRP_PEER_HOME: peerHome,
      SRP_USERNAME: username,
      SRP_EXPECTED_COMMAND: expectedCommand,
      SRP_PROOF_FILE: proofFile,
      SRP_OLD_VERSION: '1.20.88',
      SRP_TSX_LOADER: tsxLoaderUrl,
      SRP_CLI_ENTRY: cliEntry,
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let output = '';
    const fail = (error: Error) => reject(new Error(`ssh2 fixture did not start: ${error.message}; ${output}`));
    fixture.once('error', fail);
    fixture.stderr?.on('data', (data) => { output += data.toString(); });
    fixture.stdout?.on('data', (data) => {
      output += data.toString();
      const match = output.match(/PORT=(\d+)/);
      if (match) resolve(match[1]);
    });
    fixture.once('exit', (code) => fail(new Error(`exited ${code ?? 'without a code'}`)));
  });

  // `ssh -G` expands `%C` exactly as the real parent will, including its
  // default port 22. Do not use ~/.ssh/config: HOME is deliberately isolated.
  const expanded = spawnSync('ssh', [
    '-G',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPathTemplate}`,
    '-o', 'ControlPersist=60s',
    target,
  ], { encoding: 'utf-8' });
  if (expanded.status !== 0) throw new Error(`ssh -G failed: ${expanded.stderr}`);
  const socket = expanded.stdout.match(/^controlpath\s+(.+)$/m)?.[1];
  if (!socket) throw new Error(`ssh -G did not emit a controlpath: ${expanded.stdout}`);

  // The only TCP connection goes to the fixture's ephemeral port. `-S` forces
  // that master to listen at the port-22 path production's unmodified ssh call
  // will reuse below.
  const master = spawnSync('ssh', [
    '-F', '/dev/null', '-f', '-M', '-N', '-p', port, '-S', socket,
    '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ControlPersist=60s', target,
  ], { encoding: 'utf-8', timeout: 10_000 });
  if (master.status !== 0) throw new Error(`ssh ControlMaster failed: ${master.stderr}`);
  return { target, fixture, socket, proofFile, home: tempHome };
}

async function stopSessionResolverSshPeer(peer: SessionResolverSshPeer): Promise<void> {
  spawnSync('ssh', ['-F', '/dev/null', '-S', peer.socket, '-O', 'exit', peer.target], {
    encoding: 'utf-8', timeout: 10_000,
  });
  if (!peer.fixture.killed) peer.fixture.kill('SIGTERM');
  await new Promise<void>((resolve) => peer.fixture.once('exit', () => resolve()));
  // The peer side lingers past fixture death: the npx'd old agents-cli that
  // answered over ssh (still flushing its index into peer-home/.agents) and
  // the parent's own ControlPersist master. Both keep writing into the temp
  // home, which raced the cleanup rmdir ENOTEMPTY on CI even with rm retries.
  // Every one of those processes carries this test's unique temp path in argv,
  // so a path-scoped pkill reaps exactly them and nothing else.
  spawnSync('pkill', ['-f', peer.home]);
}

/**
 * rm -rf the peer test's temp home, tolerating the trailing writes the peer
 * side (an npx'd old agents-cli answering over ssh, plus the ControlPersist
 * master winding down) races into it after stop — a bare rmSync intermittently
 * dies ENOTEMPTY on CI. Retries absorb exactly that window.
 *
 * Two hardenings after 8 x 250ms still lost the race on a loaded runner
 * (`ENOTEMPTY: rmdir '/tmp/sr-46716N/peer-home'`, which failed PRs whose diff
 * never touched sessions at all):
 *
 *  - The window is now 20 x 500ms. `stopSessionResolverSshPeer` awaits the ssh
 *    exit, but the ControlPersist master and the npx'd peer are separate
 *    processes that can outlive it, so the tail is bounded by process teardown,
 *    not by anything this test controls.
 *  - Cleanup is best-effort. Every assertion has already run by the time this
 *    is reached in `finally`; a leaked directory under TMPDIR on an ephemeral
 *    runner is not a test failure, and turning one into a red shard hides which
 *    PRs are actually broken. The failure is still reported on stderr rather
 *    than swallowed, so a genuine leak stays visible in the CI log.
 */
function rmTempHomeWithRetries(tempHome: string): void {
  try {
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (err) {
    console.warn(`[sessions.test] temp home cleanup did not complete for ${tempHome}: ${(err as Error).message}`);
  }
}

describe('resolveSessionQuery indexed metadata coverage', () => {
  it('resolves complete and partial ids from the real index without using text matches', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resolve-index-'));
    try {
      const runner = [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const { upsertSession, closeDB } = await import('./src/lib/session/db.ts');",
        "const { resolveSessionQuery } = await import('./src/commands/sessions.ts');",
        "const home = process.env.HOME;",
        "const add = (id, topic, content = '') => { const filePath = path.join(home, id + '.jsonl'); fs.writeFileSync(filePath, ''); upsertSession({ id, shortId: id.slice(0, 8), agent: 'claude', timestamp: new Date().toISOString(), filePath, topic }, content); };",
        "const indexed = 'a7c1d88d-b543-48c1-993d-dd5cd8e210c9'; add(indexed, 'old but present');",
        "const rush = 'session_001fa16e-9f97-453d-b0f0-5c35317bcd04'; add(rush, 'competitive watch');",
        "const mentioner = 'aaaa1111-1111-2222-3333-444455556666'; add(mentioner, 'resume previous work: bbbb2222', 'resume previous work bbbb2222 earlier');",
        "const prefix = 'cccc3333-1111-2222-3333-444455556666'; add(prefix, 'the real one');",
        "const localOnly = 'dddd4444-1111-2222-3333-444455556666'; add(localOnly, 'local only');",
        "const pick = (selector, options) => { const r = resolveSessionQuery([], selector, options); return { ids: r.matches.map(s => s.id), byId: r.byId, completeId: r.completeId }; };",
        "const out = { indexed: pick(indexed), rush: pick(rush), absent: pick('2feeb449-5c73-4f1c-9163-8459e7aafeea'), phrase: pick('old but present'), mention: pick('bbbb2222'), prefix: pick('cccc3333'), noFallback: pick('dddd4444', { indexFallback: false }) };",
        "closeDB(); process.stdout.write(JSON.stringify(out));",
      ].join(' ');
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', runner], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        indexed: { ids: ['a7c1d88d-b543-48c1-993d-dd5cd8e210c9'], byId: true, completeId: true },
        rush: { ids: ['session_001fa16e-9f97-453d-b0f0-5c35317bcd04'], byId: true, completeId: true },
        absent: { ids: [], byId: true, completeId: true },
        phrase: { ids: [], byId: false, completeId: false },
        mention: { ids: [], byId: true, completeId: false },
        prefix: { ids: ['cccc3333-1111-2222-3333-444455556666'], byId: true, completeId: false },
        noFallback: { ids: [], byId: true, completeId: false },
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('RUSH-2203 local full-UUID hit skips SSH', () => {
  it('resolves a full id from the local DB with ZERO dials, but a label still consults the fleet', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-local-hit-'));
    try {
      const runner = [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const { upsertSession, closeDB } = await import('./src/lib/session/db.ts');",
        "const { resolveSessionMetadataValue } = await import('./src/commands/sessions.ts');",
        "const home = process.env.HOME;",
        "const id = '019fd0c8-b3e9-77a2-a1a4-444698c4d897';",
        "const filePath = path.join(home, id + '.jsonl'); fs.writeFileSync(filePath, '');",
        "upsertSession({ id, shortId: id.slice(0, 8), agent: 'claude', timestamp: new Date().toISOString(), filePath, label: 'ship the resume fix' }, '');",
        // Any dial throws so we can prove whether a peer was contacted.
        "let dialed = 0;",
        "const deps = { gatherRemoteList: async () => { dialed++; throw new Error('SSH DIALED'); } };",
        // Full UUID: globally unique, resolves before any fan-out (dialed stays 0).
        "const byId = await resolveSessionMetadataValue(id, {}, deps);",
        "const idDials = dialed;",
        // Label: NOT globally unique, so it must consult the fleet (a peer could
        // hold a same-label session) — the throwing dep makes it fail closed.
        "const byLabel = await resolveSessionMetadataValue('ship the resume fix', {}, deps);",
        "closeDB();",
        "process.stdout.write(JSON.stringify({ byIdKind: byId.kind, byIdId: byId.session && byId.session.id, idDials, byLabelKind: byLabel.kind, labelDialed: dialed > idDials }));",
      ].join(' ');
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', runner], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        byIdKind: 'resolved',
        byIdId: '019fd0c8-b3e9-77a2-a1a4-444698c4d897',
        idDials: 0,          // zero SSH: the local index answered the UUID lookup
        byLabelKind: 'partial', // label failed closed because the (throwing) fleet was consulted
        labelDialed: true,   // the label DID reach the fan-out
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('agents sessions --resolve local-peer critical path', () => {
  it('resolves a full id, unique prefix, and keywords through the metadata-only CLI contract', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resolve-local-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'face7777-1111-4222-8333-444455556666';
      writeClaudeSession(tempHome, 'resolve-local', sessionId, repoDir, 'needle metadata contract', '2026-08-03T09:00:00.000Z');
      const indexed = runAgents(['sessions', '--all', '--json', '--local'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      for (const selector of [sessionId, 'face7777', 'needle metadata contract']) {
        const result = runAgents(['sessions', '--resolve', selector, '--json', '--local'], repoDir, tempHome);
        expect(result.status, result.stderr).toBe(0);
        const rows = JSON.parse(result.stdout) as SessionMeta[];
        expect(rows.map(row => row.id)).toEqual([sessionId]);
        expect(rows[0]).not.toHaveProperty('filePath');
        expect(rows[0]).not.toHaveProperty('plan');
        expect(rows[0].origin).toBe('cli');
        expect(rows[0]).not.toHaveProperty('account');
        expect(rows[0]).not.toHaveProperty('cwd');
        expect(rows[0]).not.toHaveProperty('mode');
        expect(rows[0]).not.toHaveProperty('recentDirectoriesTouched');
      }
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('fails ambiguity with every full-id candidate and keeps misses explicit', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resolve-errors-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const first = 'cafe8888-1111-4222-8333-444455556666';
      const second = 'cafe8888-aaaa-4bbb-8ccc-ddddeeeeffff';
      writeClaudeSession(tempHome, 'resolve-errors', first, repoDir, 'first ambiguity candidate', '2026-08-03T09:00:00.000Z');
      writeClaudeSession(tempHome, 'resolve-errors', second, repoDir, 'second ambiguity candidate', '2026-08-03T09:01:00.000Z');
      const indexed = runAgents(['sessions', '--all', '--json', '--local'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const ambiguous = runAgents(['sessions', '--resolve', 'cafe8888', '--json', '--local'], repoDir, tempHome);
      expect(ambiguous.status).toBe(1);
      expect(ambiguous.stdout).toBe('');
      expect(ambiguous.stderr).toContain(first);
      expect(ambiguous.stderr).toContain(second);

      const missing = runAgents(['sessions', '--resolve', 'bade9999', '--json', '--local'], repoDir, tempHome);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain('No session found matching: bade9999');

      const empty = runAgents(['sessions', '--resolve', '   ', '--json', '--local'], repoDir, tempHome);
      expect(empty.status).toBe(1);
      expect(empty.stdout).toBe('');
      expect(empty.stderr).toContain('--resolve requires a non-empty selector');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('keeps a peer-owned content-only FTS hit, projects safe metadata, and dedupes synced copies', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resolve-peer-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'abcd7777-1111-4222-8333-444455556666';
      const sessionsDir = path.join(tempHome, '.claude', 'projects', 'resolve-peer');
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), [
        JSON.stringify({
          type: 'user', timestamp: '2026-08-03T09:00:00.000Z', cwd: repoDir,
          sessionId, version: '2.1.110', gitBranch: 'main',
          message: { role: 'user', content: 'unrelated first prompt' },
        }),
        JSON.stringify({
          type: 'user', timestamp: '2026-08-03T09:01:00.000Z', cwd: repoDir,
          sessionId, version: '2.1.110', gitBranch: 'main',
          message: { role: 'user', content: 'recap resolver hidden content' },
        }),
      ].join('\n') + '\n');

      // Prime the durable index the same way a normal sessions listing does.
      // The resolver invocation below must then read only that indexed row.
      const indexed = runAgents(['sessions', '--all', '--json', '--local'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const peer = runAgents(
        ['sessions', '--resolve-safe-v1', 'recap resolver', '--json', '--all', '--local'],
        repoDir,
        tempHome,
        { AGENTS_SESSIONS_LOCAL: '1' },
      );
      expect(peer.status, peer.stderr).toBe(0);
      const peerRows = JSON.parse(peer.stdout) as Array<Record<string, unknown>>;
      expect(peerRows).toHaveLength(1);
      expect(peerRows[0].id).toBe(sessionId);
      expect(peerRows[0]).toHaveProperty('origin');
      expect(peerRows[0]).not.toHaveProperty('filePath');
      expect(peerRows[0]).not.toHaveProperty('plan');

      const remoteRows = parseRemoteList(peer.stdout, 'peer-one');
      const mirrored = remoteRows.map(row => ({ ...row, machine: 'peer-two' }));
      const candidates = fleetCandidatesByQuery([...remoteRows, ...mirrored], 'recap resolver');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(sessionId);
      expect(candidates[0].hits.map(hit => hit.machine).sort()).toEqual(['peer-one', 'peer-two']);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves one exact UUID even when unrelated fleet peers are unavailable', () => {
    const id = '019fd0c8-b3e9-77a2-a1a4-444698c4d897';
    const session: SessionMeta = {
      id,
      shortId: '019fd0c8',
      agent: 'codex',
      version: '0.146.0',
      mode: 'edit',
      machine: 'yosemite-s0',
      timestamp: '2026-08-05T09:29:43.616Z',
      filePath: '/sessions/codex.jsonl',
    };
    expect(metadataResolveOutcome([session], { sessions: [], unreachable: ['offline-box'] }, id)).toEqual({
      kind: 'resolved',
      session,
    });
    expect(metadataResolveOutcome([session], { sessions: [], unreachable: ['offline-box'] }, '019fd0c8')).toEqual({
      kind: 'partial',
      failedPeers: ['offline-box'],
    });
  });

  // POSIX-only (RUSH-2215): grafts a real ssh2 peer onto an OpenSSH
  // `ControlMaster=auto` multiplexing socket, which Windows OpenSSH does not
  // support — the ControlMaster startup hangs the fixture (and the suite) rather
  // than failing fast, so this real-peer path only runs on a POSIX host.
  it.skipIf(process.platform === 'win32')('returns a partial fleet result when a real old peer rejects the safe resolver protocol', async () => {
    const tempHome = fs.mkdtempSync(path.join(sshPeerTmpBase, 'sr-'));
    let peer: SessionResolverSshPeer | undefined;
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work');
      fs.mkdirSync(repoDir, { recursive: true });
      peer = await startSessionResolverSshPeer('old-peer', tempHome);

      const result = runAgents(
        ['sessions', '--resolve', 'abcd7777', '--json', '--host', peer.target],
        repoDir,
        tempHome,
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(peer.target);
      expect(result.stderr).toContain('No unique/no-match decision was made.');
      expect(fs.readFileSync(peer.proofFile, 'utf-8')).toBe(
        "1.20.88:unknown option '--resolve-safe-v1'\n",
      );
    } finally {
      if (peer) await stopSessionResolverSshPeer(peer);
      rmTempHomeWithRetries(tempHome);
    }
  }, 90_000);

  // POSIX-only (RUSH-2215): same real ssh2 peer over an OpenSSH ControlMaster
  // multiplexing socket as the sibling test above — hangs on Windows OpenSSH.
  it.skipIf(process.platform === 'win32')('returns a partial fleet result when a real exit-zero peer emits malformed safe output', async () => {
    const tempHome = fs.mkdtempSync(path.join(sshPeerTmpBase, 'sr-'));
    let peer: SessionResolverSshPeer | undefined;
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work');
      fs.mkdirSync(repoDir, { recursive: true });
      peer = await startSessionResolverSshPeer('malformed', tempHome);

      const result = runAgents(
        ['sessions', '--resolve', 'abcd7777', '--json', '--host', peer.target],
        repoDir,
        tempHome,
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(peer.target);
      expect(result.stderr).toContain('No unique/no-match decision was made.');
    } finally {
      if (peer) await stopSessionResolverSshPeer(peer);
      rmTempHomeWithRetries(tempHome);
    }
  });

  it('exits 2 when the real parent cannot read the device registry', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resolve-registry-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work');
      const devicesDir = path.join(tempHome, 'broken-devices');
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.writeFileSync(path.join(devicesDir, 'registry.json'), '{broken');
      const result = runAgents(
        ['sessions', '--resolve', 'abcd7777', '--json'],
        repoDir,
        tempHome,
        { AGENTS_DEVICES_DIR: devicesDir },
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('device registry');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('forwards resolver scope to every peer', () => {
    expect(metadataResolveForwardedArgs('recap resolver', { agent: 'codex@0.146.0', project: 'agents-cli' })).toEqual([
      'sessions', '--resolve-safe-v1', 'recap resolver', '--json', '--all', '--local',
      '--agent', 'codex@0.146.0', '--project', 'agents-cli',
    ]);
  });
});

function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

describe('agents sessions', () => {
  // Multiple full CLI `runAgents` passes — under ubuntu-22 CI this has hit the
  // default 30s vitest cap (release 1.22.2/1.22.3 home-base gate). Give it 2m.
  it('queries two distinct tool calls without changing the ordinary list JSON contract', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-tools-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const projectDir = path.join(tempHome, '.claude', 'projects', 'agents-cli-tools');
      const sessionId = '91919191-9191-4919-8919-919191919191';
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      const rows = [
        { type: 'user', timestamp: '2026-08-03T00:00:00Z', cwd: repoDir, sessionId, message: { role: 'user', content: 'resolve \x1b[2Jconflicts' } },
        { type: 'assistant', timestamp: '2026-08-03T00:00:01Z', message: { content: [{ type: 'tool_use', id: 'git-1', name: 'Bash', input: { command: 'git merge topic; git status' } }] } },
        { type: 'user', timestamp: '2026-08-03T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'git-1', content: 'merge stopped' }] } },
        { type: 'assistant', timestamp: '2026-08-03T00:00:03Z', message: { content: [{ type: 'tool_use', id: 'gh-1', name: 'Bash', input: { command: 'gh pr view' } }] } },
        { type: 'user', timestamp: '2026-08-03T00:00:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 'gh-1', content: 'CONFLICT in app.ts', is_error: true }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

      // The ordinary incremental scan owns parsing. Tool queries below read
      // only the SQLite snapshot populated by this pass.
      expect(runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome).status).toBe(0);

      const toolResult = runAgents([
        'sessions', '--include', 'tools',
        '--query', 'program:git input:merge',
        '--query', 'program:gh output:CONFLICT',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(toolResult.status).toBe(0);
      const toolJson = JSON.parse(toolResult.stdout) as { schemaVersion: number; sessions: Array<{ id: string; filePath?: string; calls: unknown[] }> };
      expect(toolJson.schemaVersion).toBe(1);
      expect(toolJson.sessions).toEqual([expect.objectContaining({ id: sessionId, calls: expect.any(Array) })]);
      expect(toolJson.sessions[0].calls).toHaveLength(2);
      expect(toolJson.sessions[0].filePath).toBeUndefined();

      const countResult = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git', '--count',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(countResult.status).toBe(0);
      expect(JSON.parse(countResult.stdout)).toMatchObject({
        kind: 'tool-program-count',
        query: { program: 'git', semantics: 'static-program-occurrences-v1' },
        totals: { occurrences: 2, toolCalls: 1, sessions: 1 },
      });

      const invalidCount = runAgents([
        'sessions', '--include', 'tools', '--query', 'input:git', '--count',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(invalidCount.status).toBe(1);
      expect(invalidCount.stderr).toContain('exactly one --query program:<name>');

      const humanResult = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git',
        '--all', '--no-interactive',
      ], repoDir, tempHome);
      expect(humanResult.status).toBe(0);
      expect(humanResult.stdout).toContain('resolve conflicts');
      expect(humanResult.stdout).not.toContain('\x1b');

      const exactResult = runAgents([
        'sessions', sessionId, '--include', 'tools', '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(exactResult.status).toBe(0);
      const exactJson = JSON.parse(exactResult.stdout) as { schemaVersion: number; sessions: Array<{ id: string; calls: unknown[] }> };
      expect(exactJson.sessions).toEqual([expect.objectContaining({ id: sessionId })]);
      expect(exactJson.sessions[0].calls).toHaveLength(2);

      fs.appendFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
        { type: 'assistant', timestamp: '2026-08-03T00:00:05Z', message: { content: [{ type: 'tool_use', id: 'pwd-1', name: 'Bash', input: { command: 'pwd' } }] } },
        { type: 'user', timestamp: '2026-08-03T00:00:06Z', message: { content: [{ type: 'tool_result', tool_use_id: 'pwd-1', content: repoDir }] } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      const staleExactResult = runAgents([
        'sessions', sessionId, '--include', 'tools', '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(JSON.parse(staleExactResult.stdout).sessions[0].calls).toHaveLength(2);

      expect(runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome).status).toBe(0);
      const refreshedExactResult = runAgents([
        'sessions', sessionId, '--include', 'tools', '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(refreshedExactResult.status).toBe(0);
      const refreshedExactJson = JSON.parse(refreshedExactResult.stdout) as { sessions: Array<{ calls: Array<{ programs: string[] }> }> };
      expect(refreshedExactJson.sessions[0].calls).toHaveLength(3);
      expect(refreshedExactJson.sessions[0].calls).toContainEqual(expect.objectContaining({ programs: ['pwd'] }));

      const excessiveClauses = runAgents([
        'sessions', '--include', 'tools', '--all', '--json', '--no-interactive',
        ...Array.from({ length: 33 }, () => ['--query', 'program:git']).flat(),
      ], repoDir, tempHome);
      expect(excessiveClauses.status).toBe(1);
      expect(excessiveClauses.stderr).toContain('at most 32');

      const contradictoryScope = runAgents([
        'sessions', sessionId, '--include', 'tools', '--local',
        '--device', 'definitely-remote', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(contradictoryScope.status).toBe(1);
      expect(contradictoryScope.stderr).toContain('--local and --device name opposite scopes');

      for (const conflictingFlag of ['--markdown', '--no-redact']) {
        const conflict = runAgents([
          'sessions', sessionId, '--include', 'tools', conflictingFlag,
          '--all', '--json', '--no-interactive',
        ], repoDir, tempHome);
        expect(conflict.status).toBe(1);
        expect(conflict.stderr).toContain(`${conflictingFlag} cannot be used with --include tools`);
      }

      const listResult = runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome);
      expect(listResult.status).toBe(0);
      expect(Array.isArray(JSON.parse(listResult.stdout))).toBe(true);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 120_000);

  it('omits a synced mirror when answering a fleet evidence partition', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-tool-mirror-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const projectDir = path.join(
        tempHome,
        '.agents',
        '.history',
        'backups',
        'claude',
        'origin-one',
        'projects',
        'agents-cli-tools',
      );
      const sessionId = '92929292-9292-4929-8929-929292929292';
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
        { type: 'user', timestamp: '2026-08-03T00:00:00Z', cwd: repoDir, sessionId, message: { role: 'user', content: 'mirrored command' } },
        { type: 'assistant', timestamp: '2026-08-03T00:00:01Z', message: { content: [{ type: 'tool_use', id: 'git-1', name: 'Bash', input: { command: 'git status' } }] } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');

      const indexed = runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const localCache = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(localCache.status, localCache.stderr).toBe(0);
      expect(JSON.parse(localCache.stdout).sessions).toHaveLength(1);

      const fleetPartition = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome, { [NO_FANOUT_ENV]: '1' });
      expect(fleetPartition.status, fleetPartition.stderr).toBe(0);
      expect(JSON.parse(fleetPartition.stdout).sessions).toEqual([]);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('lists only sessions from the current directory by default and shows all with --all', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-list-'));

    try {
      writeUpdateCache(tempHome);

      const phnxDir = path.join(tempHome, 'work', 'phnx-labs');
      const agentsCliDir = path.join(tempHome, 'work', 'agents-cli');
      const phnxSessionId = '11111111-1111-4111-8111-111111111111';
      const agentsCliSessionId = '22222222-2222-4222-8222-222222222222';

      writeClaudeSession(
        tempHome,
        'phnx-labs-test',
        phnxSessionId,
        phnxDir,
        'Inspect the phnx-labs session list',
        '2026-04-17T19:35:30.000Z'
      );
      writeClaudeSession(
        tempHome,
        'agents-cli-test',
        agentsCliSessionId,
        agentsCliDir,
        'Inspect the agents-cli session list',
        '2026-04-17T19:36:30.000Z'
      );

      const localResult = runAgents(['sessions'], phnxDir, tempHome);
      expect(localResult.status).toBe(0);

      const localOutput = outputOf(localResult);
      expect(localOutput).toContain(phnxSessionId.slice(0, 8));
      expect(localOutput).not.toContain(agentsCliSessionId.slice(0, 8));

      const allResult = runAgents(['sessions', '--all'], phnxDir, tempHome);
      expect(allResult.status).toBe(0);

      const allOutput = outputOf(allResult);
      expect(allOutput).toContain(phnxSessionId.slice(0, 8));
      expect(allOutput).toContain(agentsCliSessionId.slice(0, 8));
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('shows message and token counts while skipping Claude local-command preambles in the topic', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-stats-'));

    try {
      writeUpdateCache(tempHome);

      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const projectKey = 'agents-cli-test';
      const sessionId = '77777777-7777-4777-8777-777777777777';

      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(path.join(tempHome, '.claude', 'projects', projectKey), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'projects', projectKey, `${sessionId}.jsonl`),
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:00.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            isMeta: true,
            message: {
              role: 'user',
              content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:01.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: '<bash-input>pwd</bash-input>' },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:02.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: 'Inspect session stats' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:00:03.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              id: 'msg-stats',
              role: 'assistant',
              content: [{ type: 'text', text: 'Looking now.' }],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 0,
              },
            },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:00:04.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              id: 'msg-stats',
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/example' } }],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 0,
              },
            },
          }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const result = runAgents(['sessions'], repoDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      // Core intent of this test: topic rendering skips the Claude
      // local-command preamble ("Caveat: ...") and shows the real prompt.
      // The Msgs/Tokens column assertion was dropped when the session table
      // was simplified to ID / agent / project / topic / when.
      const row = output.split('\n').find(line => line.includes(sessionId.slice(0, 8))) || '';
      expect(row).toContain('Inspect session stats');
      expect(row).not.toContain('Caveat:');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('finds matching projects outside the current directory when --project is provided', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-project-'));

    try {
      writeUpdateCache(tempHome);

      const workspaceDir = path.join(tempHome, 'work');
      const phnxDir = path.join(workspaceDir, 'phnx-labs');
      const agentsCliDir = path.join(workspaceDir, 'agents-cli');
      const phnxSessionId = '55555555-5555-4555-8555-555555555555';
      const agentsCliSessionId = '66666666-6666-4666-8666-666666666666';

      fs.mkdirSync(workspaceDir, { recursive: true });

      writeClaudeSession(
        tempHome,
        'phnx-labs-test',
        phnxSessionId,
        phnxDir,
        'Inspect the phnx-labs session list',
        '2026-04-17T19:35:30.000Z'
      );
      writeClaudeSession(
        tempHome,
        'agents-cli-test',
        agentsCliSessionId,
        agentsCliDir,
        'Inspect the agents-cli session list',
        '2026-04-17T19:36:30.000Z'
      );

      const result = runAgents(['sessions', '--project', 'agents-cli'], workspaceDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(agentsCliSessionId.slice(0, 8));
      expect(output).not.toContain(phnxSessionId.slice(0, 8));
      expect(output).not.toContain(`No sessions found for ${workspaceDir}`);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('shows the first human Codex prompt instead of injected session scaffolding', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-codex-topic-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = '99999999-9999-4999-8999-999999999999';
      const prompt = 'Search across sessions by prompt text';

      writeCodexSession(
        tempHome,
        sessionId,
        projectDir,
        prompt,
        '2026-04-17T19:40:30.000Z'
      );

      const result = runAgents(['sessions', '--all'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(sessionId.slice(0, 8));
      expect(output).toContain(prompt);
      expect(output).not.toContain('Collaboration Mode: Default');
      expect(output).not.toContain('# AGENTS.md instructions');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('lists Codex sessions when filtered by --agent', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-codex-version-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      writeCodexSession(
        tempHome,
        'abababab-abab-4bab-8bab-abababababab',
        projectDir,
        'Show codex versions in the session list',
        '2026-04-17T19:42:30.000Z'
      );

      const result = runAgents(['sessions', '--agent', 'codex', '--all'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      // Table simplification dropped the "codex@<version>" suffix from the
      // agent column; still verify the codex session is discovered & listed.
      expect(output).toContain('codex');
      expect(output).toContain('Show codex versions in the session list');
      expect(output).toContain('abababab');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('combines --agent and --version into one structured session filter', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-agent-version-flags-'));
    try {
      writeUpdateCache(tempHome);
      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      writeCodexSession(tempHome, 'acacacac-acac-4cac-8cac-acacacacacac', projectDir,
        'Filter this exact Codex version', '2026-04-17T19:43:30.000Z');

      const match = runAgents(
        ['sessions', '--agent', 'codex', '--version', '0.113.0', '--all', '--no-interactive'],
        projectDir, tempHome,
      );
      expect(match.status, match.stderr).toBe(0);
      expect(outputOf(match)).toContain('Filter this exact Codex version');

      const miss = runAgents(
        ['sessions', '--agent', 'codex', '--version', '9.9.9', '--all', '--no-interactive'],
        projectDir, tempHome,
      );
      expect(miss.status, miss.stderr).toBe(0);
      expect(outputOf(miss)).not.toContain('Filter this exact Codex version');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects --version without an agent instead of silently ignoring it', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-version-without-agent-'));
    try {
      writeUpdateCache(tempHome);
      const result = runAgents(['sessions', '--version', '2.1.181', '--no-interactive'], tempHome, tempHome);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--version requires --agent');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it.each([
    [['sessions', '--version']],
    [['sessions', '--agent', 'claude', '--version', '--no-interactive']],
  ])('rejects a sessions --version flag with no value: %j', (args) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-version-without-value-'));
    try {
      writeUpdateCache(tempHome);
      const result = runAgents(args, tempHome, tempHome);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("option '--version <version>' argument missing");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('lists Gemini sessions from a managed version home', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-gemini-version-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      writeGeminiSession(
        tempHome,
        'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
        projectDir,
        'Show gemini versions in the session list',
        '2026-04-17T19:43:30.000Z'
      );

      const result = runAgents(['sessions', '--agent', 'gemini', '--all'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      // Version suffix in the agent column was removed by the table
      // simplification. Still verify the session is discovered & listed.
      expect(output).toContain('gemini');
      expect(output).toContain('Show gemini versions in the session list');
      expect(output).toContain('f0f0f0f0');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // The fixture's openclaw binary is a `#!/bin/sh` script and the assertions
  // depend on its stdout (channels status / cron list) — shebang scripts don't
  // execute on Windows, so there's no synthetic-session data to discover there.
  it.skipIf(process.platform === 'win32')('shows OpenClaw synthetic sessions from the configured workspace without --all', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-openclaw-cwd-'));

    try {
      writeUpdateCache(tempHome);
      const openClawWorkspace = writeOpenClawSetup(tempHome);

      const result = runAgents(['sessions', '--agent', 'openclaw'], openClawWorkspace, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      // The "openclaw@<version>" suffix was dropped with the table
      // simplification; the workspace discovery (Sergey / session id) is the
      // actual behavior this test guards.
      expect(output).toContain('Sergey');
      expect(output).toContain('12345678');
      expect(output).not.toContain('No sessions found');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('agents sessions (render-mode)', () => {
  it('resolves explicit IDs across directories even when the default listing is scoped to cwd', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-global-'));

    try {
      writeUpdateCache(tempHome);

      const phnxDir = path.join(tempHome, 'work', 'phnx-labs');
      const agentsCliDir = path.join(tempHome, 'work', 'agents-cli');
      const siblingSessionId = '33333333-3333-4333-8333-333333333333';

      writeClaudeSession(
        tempHome,
        'phnx-labs-test',
        '44444444-4444-4444-8444-444444444444',
        phnxDir,
        'Inspect the phnx-labs session list',
        '2026-04-17T19:35:30.000Z'
      );
      writeClaudeSession(
        tempHome,
        'agents-cli-test',
        siblingSessionId,
        agentsCliDir,
        'Review sibling repo state',
        '2026-04-17T19:36:30.000Z'
      );

      const result = runAgents(['sessions', siblingSessionId, '--markdown'], phnxDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Review sibling repo state');
      expect(output).not.toContain(`No session found matching: ${siblingSessionId}`);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves Claude /resume history IDs to the resumed transcript', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-history-'));

    try {
      writeUpdateCache(tempHome);

      const projectRoot = path.join(tempHome, 'work', 'phnx-labs');
      const transcriptCwd = path.join(projectRoot, 'extension');
      const transcriptId = '92267176-d991-45c2-a8e5-e851e30a203b';
      const historyOnlyId = 'f6a6cd2d-2138-41c4-b653-d2881ce9cdd3';

      fs.mkdirSync(path.join(tempHome, '.claude', 'projects', 'phnx-labs-test'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'history.jsonl'),
        JSON.stringify({
          display: '/resume',
          timestamp: Date.parse('2026-04-17T19:30:00.000Z'),
          project: projectRoot,
          sessionId: historyOnlyId,
        }) + '\n',
        'utf-8'
      );
      fs.mkdirSync(transcriptCwd, { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'projects', 'phnx-labs-test', `${transcriptId}.jsonl`),
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:00.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: 'Earlier context' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:00:05.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Earlier reply' }],
            },
          }),
          JSON.stringify({
            type: 'attachment',
            timestamp: '2026-04-17T19:30:30.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            attachment: {
              type: 'hook_success',
              hookName: 'SessionStart:resume',
              hookEvent: 'SessionStart',
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:30:45.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: 'Continue from where we left off' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:31:00.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Loaded resumed transcript' }],
            },
          }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const result = runAgents(['sessions', historyOnlyId, '--markdown'], repoRoot, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      // The informational "Resolved Claude history entry ... to transcript ..."
      // status line was removed; the behavior (history ID → transcript
      // content) still works, so we assert on the loaded transcript instead.
      expect(output).toContain('Loaded resumed transcript');
      expect(output).not.toContain(`No transcript session found matching: ${historyOnlyId}`);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves text queries against session topics, not only IDs', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-query-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const prompt = 'Search across sessions by prompt text';

      writeCodexSession(
        tempHome,
        sessionId,
        projectDir,
        prompt,
        '2026-04-17T19:41:30.000Z'
      );

      const result = runAgents(['sessions', 'prompt text', '--markdown'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(prompt);
      expect(output).not.toContain('No session found matching: prompt text');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('applies --project filters before resolving search queries', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-project-filter-'));

    try {
      writeUpdateCache(tempHome);

      const workspaceDir = path.join(tempHome, 'work');
      const agentsDir = path.join(workspaceDir, 'agents');
      const agentsCliDir = path.join(workspaceDir, 'agents-cli');

      writeCodexSession(
        tempHome,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        agentsDir,
        'Filter scoped search target',
        '2026-04-17T19:42:30.000Z'
      );
      writeCodexSession(
        tempHome,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        agentsCliDir,
        'Filter scoped search decoy',
        '2026-04-17T19:43:30.000Z'
      );

      const result = runAgents(
        ['sessions', '--project', 'agents-cli', 'scoped search', '--markdown'],
        workspaceDir,
        tempHome,
      );
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Filter scoped search decoy');
      expect(output).not.toContain('Filter scoped search target');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('applies --agent filters before resolving search queries', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-agent-filter-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');

      writeClaudeSession(
        tempHome,
        'agents-cli-claude',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        projectDir,
        'Shared filter phrase from claude',
        '2026-04-17T19:44:30.000Z'
      );
      writeCodexSession(
        tempHome,
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        projectDir,
        'Shared filter phrase from codex',
        '2026-04-17T19:45:30.000Z'
      );

      const result = runAgents(
        ['sessions', '--agent', 'codex', 'shared filter phrase', '--markdown'],
        projectDir,
        tempHome,
      );
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Shared filter phrase from codex');
      expect(output).not.toContain('Shared filter phrase from claude');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('buildResumeCommand version-pinned resume', () => {
  const baseSession = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
    id: 'abc12345-def6-7890-1234-567890abcdef',
    shortId: 'abc12345',
    agent: 'claude',
    timestamp: '2026-04-19T12:00:00.000Z',
    filePath: '/fake/path.jsonl',
    ...overrides,
  });

  it('uses version-pinned binary when claude session has a recorded version', () => {
    const session = baseSession({ version: '2.1.138' });
    expect(buildResumeCommand(session)).toEqual([
      'claude@2.1.138', '--resume', session.id,
    ]);
  });

  it('falls back to bare shim when claude session has no recorded version', () => {
    const session = baseSession({ version: undefined });
    expect(buildResumeCommand(session)).toEqual([
      'claude', '--resume', session.id,
    ]);
  });

  it('uses version-pinned binary when codex session has a recorded version', () => {
    const session = baseSession({ agent: 'codex', version: '0.116.0' });
    expect(buildResumeCommand(session)).toEqual([
      'codex@0.116.0', 'resume', session.id,
    ]);
  });

  it('falls back to bare shim when codex session has no recorded version', () => {
    const session = baseSession({ agent: 'codex', version: undefined });
    expect(buildResumeCommand(session)).toEqual([
      'codex', 'resume', session.id,
    ]);
  });

  it('opencode always uses shared --session flag (not version-isolated)', () => {
    const session = baseSession({ agent: 'opencode', version: '0.5.0' });
    expect(buildResumeCommand(session)).toEqual([
      'opencode', '--session', session.id,
    ]);
  });

  it('returns null for agents without resume support', () => {
    expect(buildResumeCommand(baseSession({ agent: 'gemini', version: '1.0.0' }))).toBeNull();
    expect(buildResumeCommand(baseSession({ agent: 'openclaw', version: '1.0.0' }))).toBeNull();
  });

  // Regression: resumeSessionInPlace must spawn the resume launcher through the
  // shell on Windows. The launcher is a bare command / `.cmd` shim
  // (`claude@2.1.138`, `codex`), which `spawn` can't exec directly on win32 —
  // a `shell:false` spawn there threw `EFTYPE` and surfaced as a misleading
  // "Failed to discover sessions" error. Off Windows it must stay a direct exec.
  it('resume launcher requires a shell on win32 and not on posix', () => {
    for (const session of [
      baseSession({ version: '2.1.138' }),                       // claude@2.1.138
      baseSession({ version: undefined }),                       // bare claude
      baseSession({ agent: 'codex', version: '0.116.0' }),       // codex@0.116.0
      baseSession({ agent: 'opencode', version: '0.5.0' }),      // opencode
    ]) {
      const launcher = buildResumeCommand(session)![0];
      expect(needsWindowsShell(launcher, 'win32')).toBe(true);
      expect(needsWindowsShell(launcher, 'linux')).toBe(false);
    }
  });

  // RUSH-1753: session.id comes from the JSONL filename with no char validation.
  // spawn(cmd[0], cmd.slice(1), { shell: true }) on win32 concatenates args into
  // the cmd.exe line unescaped — so id `x&calc.exe&` injects. resumeSpawnInvocation
  // must compose a quoted line + empty argv when the shell is needed.
  it('quotes shell metacharacters in session id on win32 resume spawn (RUSH-1753)', () => {
    const evilId = 'x&calc.exe&';
    const cmd = buildResumeCommand(baseSession({ id: evilId }))!;
    expect(cmd).toEqual(['claude', '--resume', evilId]);

    const inv = resumeSpawnInvocation(cmd, 'win32');
    expect(inv.shell).toBe(true);
    expect(inv.args).toEqual([]);
    // Full line is the sole command; & | etc. sit inside quotes (not bare).
    expect(inv.command).toBe(composeWin32CommandLine(cmd[0], cmd.slice(1)));
    expect(inv.command).toBe('claude --resume "x&calc.exe&"');

    // Posix path stays a direct exec (no shell, raw argv).
    const posix = resumeSpawnInvocation(cmd, 'linux');
    expect(posix).toEqual({ command: 'claude', args: ['--resume', evilId], shell: false });
  });

  it('quotes shell metacharacters for codex and opencode resume spawn too', () => {
    const evilId = 'a|b<c>d';
    for (const session of [
      baseSession({ agent: 'codex', id: evilId }),
      baseSession({ agent: 'opencode', id: evilId }),
    ]) {
      const cmd = buildResumeCommand(session)!;
      const inv = resumeSpawnInvocation(cmd, 'win32');
      expect(inv.shell).toBe(true);
      expect(inv.args).toEqual([]);
      expect(inv.command).toBe(composeWin32CommandLine(cmd[0], cmd.slice(1)));
      expect(inv.command).toContain(`"${evilId}"`);
    }
  });
});

describe('agents sessions preview', () => {
  it('resolves the displayed 8-character id and emits the stable rich JSON envelope', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-preview-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'feed7777-1111-4222-8333-444455556666';
      writeClaudeSession(tempHome, 'preview-local', sessionId, repoDir, 'preview the session card', '2026-08-03T09:00:00.000Z');
      const indexed = runAgents(['sessions', '--all', '--json', '--local'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const result = runAgents(['sessions', 'preview', 'feed7777', '--json', '--local'], repoDir, tempHome);
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.schemaVersion).toBe(1);
      expect(output.session.id).toBe(sessionId);
      expect(output.session.shortId).toBe('feed7777');
      expect(output.active).toBeNull();
      expect(output.preview.schemaVersion).toBe(1);
      expect(output.preview.firstUser).toContain('preview the session card');
      expect(output.error).toBeNull();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('resolveSessionQuery id-vs-search resolution', () => {
  const meta = (over: Partial<SessionMeta> & { id: string }): SessionMeta => ({
    shortId: over.id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-08-01T12:00:00.000Z',
    filePath: '/fake/path.jsonl',
    ...over,
  });

  // The session the user actually asked for is absent from the pool (it lives on
  // another machine); the pool holds an unrelated session whose topic merely
  // quotes that id — the exact shape that made `sessions <uuid>` render the wrong
  // transcript and advise "Pass a longer ID" for an already-complete id.
  // Synthetic id that cannot exist in any real session DB: a complete id absent
  // from the pool now also consults the on-disk index (findSessionsById), so a
  // REAL id here would resolve from the developer's own history and make these
  // tests machine-specific (they'd fail wherever that session exists).
  const wanted = '00000000-0000-4000-8000-000000000042';
  const decoy = meta({
    id: 'ffa1f432-1a9e-4a81-8e93-e70aa8df1c95',
    topic: `Resume previous work: ${wanted}`,
  });

  it('does not answer a complete id with a session that merely mentions it', () => {
    const r = resolveSessionQuery([decoy], wanted);
    expect(r.matches).toEqual([]);
    expect(r.completeId).toBe(true);
    expect(r.byId).toBe(true);
  });

  it('still resolves a complete id that is genuinely present', () => {
    const real = meta({ id: wanted, topic: 'Improve session display' });
    const r = resolveSessionQuery([decoy, real], wanted);
    expect(r.matches.map(s => s.id)).toEqual([wanted]);
    expect(r.byId).toBe(true);
  });

  it('keeps short-id prefix lookup working', () => {
    const real = meta({ id: wanted, topic: 'Improve session display' });
    const r = resolveSessionQuery([real], '00000000');
    expect(r.matches.map(s => s.id)).toEqual([wanted]);
    expect(r.byId).toBe(true);
    expect(r.completeId).toBe(false);
  });

  it('still falls through to text search for a real search phrase', () => {
    const r = resolveSessionQuery([decoy], 'Resume previous');
    expect(r.matches.map(s => s.id)).toEqual([decoy.id]);
    expect(r.byId).toBe(false);
    expect(r.completeId).toBe(false);
  });

  // isCompleteSessionId trims but resolveSessionById does not, so without a
  // single normalization point a pasted, padded id classified as complete and
  // then missed the lookup — reporting a session that IS here as absent.
  it('resolves a padded id instead of declaring it missing', () => {
    const real = meta({ id: wanted, topic: 'Improve session display' });
    const r = resolveSessionQuery([decoy, real], `  ${wanted} `);
    expect(r.matches.map(s => s.id)).toEqual([wanted]);
    expect(r.completeId).toBe(true);
  });

  // Synthetic ids, so these assert the resolver and never the developer's own
  // session index (a complete id that MISSES the pool now also consults the DB,
  // so a real id here would resolve from disk and make the test machine-specific).
  it('resolves a session_-prefixed complete id by id, not by content', () => {
    const prefixed = 'session_00000000-0000-4000-8000-000000000001';
    const mentions = meta({ id: 'aaaa1111-2222-4333-8444-555566667777', topic: `see ${prefixed}` });
    const r = resolveSessionQuery([mentions], prefixed);
    expect(r.completeId).toBe(true);
    expect(r.matches.map(s => s.id)).not.toContain(mentions.id);
    const real = meta({ id: prefixed, topic: 'kimi run' });
    expect(resolveSessionQuery([mentions, real], prefixed).matches.map(s => s.id)).toEqual([prefixed]);
  });

  it('resolves a ses_ ULID complete id by id, not by content', () => {
    const ses = 'ses_00000000000000000000000001';
    const mentions = meta({ id: 'bbbb1111-2222-4333-8444-555566667777', topic: `see ${ses}` });
    const r = resolveSessionQuery([mentions], ses);
    expect(r.completeId).toBe(true);
    expect(r.matches.map(s => s.id)).not.toContain(mentions.id);
  });
});

describe('buildSessionDescription — team lineage', () => {
  it('shows "by <orchestrator label>" for a teammate with a resolved orchestrator', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working',
      teamName: 'my-feature', orchestratorLabel: 'refactor auth', label: 'auth',
    } as any);
    expect(desc).toContain('my-feature');
    expect(desc).toContain('by refactor auth');
  });

  it('falls back to the orchestrator short id when no label resolved', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working',
      teamName: 't', orchestratorSessionId: 'abcd1234efgh',
    } as any);
    expect(desc).toContain('by abcd1234'); // first 8 chars
  });

  it('omits the "by" clause when there is no orchestrator link', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working', teamName: 't', label: 'x',
    } as any);
    expect(desc).not.toContain('by ');
  });
});

describe('buildSessionDescription — team target + teammate', () => {
  it('shows team, teammate, orchestrator, and the assigned mission', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working',
      teamName: 'session-ship', label: 'cli-ids', orchestratorLabel: 'ship the CLI',
      assignedTask: 'Make short + full session ids resolve everywhere',
    } as any);
    expect(desc).toContain('session-ship');
    expect(desc).toContain('cli-ids');
    expect(desc).toContain('by ship the CLI');
    expect(desc).toContain('Make short + full session ids resolve everywhere');
  });
  it('prefers the live preview over the assigned mission once working', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working',
      teamName: 't', assignedTask: 'the mission', preview: 'editing usage.ts',
    } as any);
    expect(desc).toContain('editing usage.ts');
    expect(desc).not.toContain('the mission');
  });
  it('shows the assigned mission for a teammate with no transcript yet (pending)', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'pending',
      teamName: 't', assignedTask: 'wire up the auth flow',
    } as any);
    expect(desc).toContain('wire up the auth flow');
  });
});

describe('RUSH-2203 definitive-match fleet resolve', () => {
  const FULL = '019fd0c8-b3e9-77a2-a1a4-444698c4d897';
  const base: SessionMeta = {
    id: FULL,
    shortId: '019fd0c8',
    agent: 'claude',
    version: '2.1.0',
    mode: 'edit',
    machine: 'yosemite-m0',
    timestamp: '2026-08-05T09:29:43.616Z',
    filePath: '/sessions/claude.jsonl',
  };

  describe('isDefinitiveMatch', () => {
    it('treats a full UUID exact match as definitive (case-insensitive)', () => {
      expect(isDefinitiveMatch(base, FULL)).toBe(true);
      expect(isDefinitiveMatch(base, FULL.toUpperCase())).toBe(true);
      expect(isDefinitiveMatch({ ...base, id: 'other' }, FULL)).toBe(false);
    });

    it('is NOT definitive for an exact label — labels can collide across machines', () => {
      const labelled = { ...base, label: 'Fix the flaky ssh test' };
      expect(isDefinitiveMatch(labelled, 'fix the flaky ssh test')).toBe(false);
    });

    it('is NOT definitive for a short-id prefix — ambiguity needs every peer', () => {
      expect(isDefinitiveMatch(base, '019fd0c8')).toBe(false);
    });
  });

  describe('selectorAllowsEarlyExit', () => {
    it('enables early-exit ONLY for a full UUID (globally unique)', () => {
      expect(selectorAllowsEarlyExit(FULL)).toBe(true);
    });
    it('disables early-exit for labels and short-id prefixes so the sweep can surface a conflict', () => {
      expect(selectorAllowsEarlyExit('fix the flaky ssh test')).toBe(false);
      expect(selectorAllowsEarlyExit('019fd0c8')).toBe(false);
      expect(selectorAllowsEarlyExit('abcd12')).toBe(false);
    });
  });

  describe('metadataResolveOutcome with labels', () => {
    it('auto-resumes a unique exact-label match once every peer has answered', () => {
      const labelled = { ...base, label: 'ship the resume fix' };
      expect(
        metadataResolveOutcome([], { sessions: [labelled], unreachable: [] }, 'ship the resume fix'),
      ).toEqual({ kind: 'resolved', session: labelled });
    });

    it('fails closed (partial) for a label when a peer is unreachable — it may hold a same-label session', () => {
      const labelled = { ...base, label: 'ship the resume fix' };
      expect(
        metadataResolveOutcome([], { sessions: [labelled], unreachable: ['offline-box'] }, 'ship the resume fix'),
      ).toEqual({ kind: 'partial', failedPeers: ['offline-box'] });
    });

    it('surfaces a conflict when two distinct sessions share the exact label', () => {
      const one = { ...base, id: `${'1'.repeat(8)}-b3e9-77a2-a1a4-444698c4d897`, label: 'dup label' };
      const two = { ...base, id: `${'2'.repeat(8)}-b3e9-77a2-a1a4-444698c4d897`, machine: 'yosemite-m1', label: 'dup label' };
      const outcome = metadataResolveOutcome([], { sessions: [one, two], unreachable: [] }, 'dup label');
      expect(outcome.kind).toBe('ambiguous');
    });
  });

  describe('fleetNotFoundMessage', () => {
    it('reports the sweep result and never tells the user to pass --device', () => {
      const lines = fleetNotFoundMessage(FULL, 5, ['zion', 'box']).join('\n');
      expect(lines).toContain('5 devices searched');
      expect(lines).toContain('Unreachable (not searched): zion, box');
      expect(lines).not.toContain('--device');
    });

    it('handles a fleet with no reachable peers', () => {
      const lines = fleetNotFoundMessage(FULL, 0, []).join('\n');
      expect(lines).toContain('No other reachable devices to search.');
      expect(lines).not.toContain('--device');
    });
  });
});
