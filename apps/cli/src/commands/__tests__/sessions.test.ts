import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildResumeCommand, resumeSpawnInvocation } from '../sessions.js';
import { needsWindowsShell, composeWin32CommandLine } from '../../lib/platform/index.js';
import type { SessionMeta } from '../../lib/session/types.js';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
// Run the CLI as `node --import <tsx loader> src/index.ts`: spawning `node`
// (always on PATH, no .cmd shell launcher) with the tsx ESM loader resolved to
// an absolute file URL keeps tsx loadable regardless of the spawn cwd (which we
// point at the project dir). Avoids both the Windows `tsx.cmd`-needs-a-shell
// problem and shell:true arg-concatenation (which would split multi-word query
// args like "prompt text").
const tsxLoaderUrl = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

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

function runAgents(args: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, ['--import', tsxLoaderUrl, cliEntry, ...args], {
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
    },
    encoding: 'utf-8',
  });
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

describe('agents sessions', () => {
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
