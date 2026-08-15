#!/usr/bin/env node
/**
 * Real SSH2-protocol peer used by sessions.test.ts's two fleet-failure tests.
 *
 * Listens on 127.0.0.1 with an ephemeral port, accepts one real ssh connection
 * for one random test-only username, and on the exec channel runs only the
 * exact command string the test computed through production's
 * `remoteListCommand`. The command uses a real shell, with
 * PATH arranged so `agents` resolves to whichever CLI this test case needs:
 *
 *   - mode=old-peer:   the actual published @phnx-labs/agents-cli@1.20.88,
 *                       fetched via npx. That build predates `--resolve-safe-v1`
 *                       and rejects it with a real commander exit 1 — no
 *                       fixture-side stubbing of that behavior at all.
 *   - mode=malformed:  the current repo's CLI (via tsx), run for real. Once it
 *                       has genuinely exited 0, the fixture corrupts only the
 *                       bytes handed back over the ssh channel — simulating a
 *                       transport-level corruption, not a CLI failure.
 *
 * Configuration arrives via env vars (read only by this fixture, never by
 * production source) rather than argv, to keep the process listing short:
 *   SRP_MODE        'old-peer' | 'malformed'
 *   SRP_HOST_KEY    path to an OpenSSH-format private host key (PEM)
 *   SRP_PEER_HOME   HOME the spawned peer CLI runs with (pre-initialized)
 *   SRP_USERNAME    random username accepted through SSH's `none` method
 *   SRP_EXPECTED_COMMAND exact production command accepted by the exec channel
 *   SRP_PROOF_FILE  written only after the old CLI rejects the new protocol
 *   SRP_OLD_VERSION exact npm version to fetch for mode=old-peer
 *   SRP_TSX_LOADER  file:// URL of the tsx ESM loader (mode=malformed)
 *   SRP_CLI_ENTRY   absolute path to src/index.ts (mode=malformed)
 *
 * Prints exactly one line, `PORT=<n>`, once listening, then serves a single
 * connection and exits. The test kills the process in its `finally` block, so
 * there is no server left running beyond one test case.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import pkg from 'ssh2';

const { Server } = pkg;

const mode = process.env.SRP_MODE;
if (mode !== 'old-peer' && mode !== 'malformed') {
  throw new Error(`SRP_MODE must be 'old-peer' or 'malformed', got ${JSON.stringify(mode)}`);
}
const hostKey = fs.readFileSync(process.env.SRP_HOST_KEY);
const peerHome = process.env.SRP_PEER_HOME;
const username = process.env.SRP_USERNAME;
const expectedCommand = process.env.SRP_EXPECTED_COMMAND;
const proofFile = process.env.SRP_PROOF_FILE;
if (!username || !expectedCommand || !proofFile) {
  throw new Error('SRP_USERNAME, SRP_EXPECTED_COMMAND, and SRP_PROOF_FILE are required');
}

/** A one-shot shim dir so the peer's `bash -lc` finds `agents` on PATH,
 * resolving to whichever CLI this mode needs to actually run. */
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resolver-ssh-shim-'));
const shimBin = path.join(shimDir, 'agents');
if (mode === 'old-peer') {
  fs.writeFileSync(
    shimBin,
    `#!/bin/sh\nexec env npm_config_cache='${path.join(peerHome, 'npm-cache')}' npm_config_offline=true npx -y -p @phnx-labs/agents-cli@${process.env.SRP_OLD_VERSION} agents "$@"\n`,
  );
} else {
  fs.writeFileSync(
    shimBin,
    `#!/bin/sh\nexec ${process.execPath} --import '${process.env.SRP_TSX_LOADER}' '${process.env.SRP_CLI_ENTRY}' "$@"\n`,
  );
}
fs.chmodSync(shimBin, 0o755);

// RUSH-2750: `bash -lc` is a LOGIN shell, and on macOS every login bash sources
// `/etc/profile`, which runs `/usr/libexec/path_helper` -- that rebuilds PATH
// from `/etc/paths` + `/etc/paths.d/*` and appends whatever PATH was already
// set (this shimDir) at the very END, after `/opt/homebrew/bin` (Homebrew's own
// `/etc/paths.d` entry). On a box with a real `agents` install there, the real
// binary silently wins over this shim and the fixture never sees the CLI it
// asked for. `/etc/profile` sources `~/.bash_profile` next (HOME is `peerHome`
// here), so writing one there runs strictly after path_helper and can safely
// re-prepend the shim -- effective only for this fixture's throwaway peerHome,
// never the real user's shell.
fs.writeFileSync(
  path.join(peerHome, '.bash_profile'),
  `export PATH="${shimDir}:$PATH"\n`,
);

// RUSH-2639: this exec channel is exactly the "child process launched through
// a login-shell-like boundary" class the fork-private AGENTS_* isolation vars
// exist for (see tests/setup.ts). The env below used to start from scratch
// with only HOME/USERPROFILE/PATH/NODE_NO_WARNINGS, silently dropping every
// hermeticity escape hatch (AGENTS_DEVICES_DIR, AGENTS_STATE_DIR,
// AGENTS_SECRETS_AGENT_DIR, AGENTS_EVENTS_PATH, AGENTS_HOOK_SHIMS_DIR,
// AGENTS_HOOK_CACHE_DIR, AGENTS_LOGS_DIR, AGENTS_PERF_DIR, AGENTS_REAL_HOME)
// the parent vitest fork set — the one spawn path in sessions.test.ts that
// did not carry them through, unlike every other subprocess helper in this
// file. Forward them so the exec'd CLI resolves everything under peerHome
// instead of falling back to a real-HOME-derived default.
const FORWARDED_ISOLATION_VARS = [
  'AGENTS_DEVICES_DIR',
  'AGENTS_STATE_DIR',
  'AGENTS_SECRETS_AGENT_DIR',
  'AGENTS_SECRETS_NO_AGENT',
  'AGENTS_NO_USAGE_TRACK',
  'AGENTS_EVENTS_PATH',
  'AGENTS_HOOK_SHIMS_DIR',
  'AGENTS_HOOK_CACHE_DIR',
  'AGENTS_LOGS_DIR',
  'AGENTS_PERF_DIR',
  'AGENTS_REAL_HOME',
];

function runExecCommand(command) {
  return new Promise((resolve) => {
    const inherited = process.env;
    const forwarded = {};
    for (const key of FORWARDED_ISOLATION_VARS) {
      if (inherited[key] !== undefined) forwarded[key] = inherited[key];
    }
    const child = spawn('bash', ['-c', command], {
      cwd: peerHome,
      env: {
        HOME: peerHome,
        USERPROFILE: peerHome,
        PATH: `${shimDir}${path.delimiter}${inherited.PATH || ''}`,
        NODE_NO_WARNINGS: '1',
        AGENTS_SKIP_MIGRATION: '1',
        ...forwarded,
        ...(inherited.HTTP_PROXY ? { HTTP_PROXY: inherited.HTTP_PROXY } : {}),
        ...(inherited.HTTPS_PROXY ? { HTTPS_PROXY: inherited.HTTPS_PROXY } : {}),
        ...(inherited.NO_PROXY ? { NO_PROXY: inherited.NO_PROXY } : {}),
        ...(inherited.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: inherited.NODE_EXTRA_CA_CERTS } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'none' && ctx.username === username) ctx.accept();
    else ctx.reject();
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept, _reject, info) => {
        const stream = accept();
        if (info.command !== expectedCommand) {
          stream.stderr.write('fixture: rejected unexpected command');
          stream.exit(126);
          stream.end();
          return;
        }
        runExecCommand(info.command).then(({ code, stdout, stderr }) => {
          if (mode === 'old-peer') {
            const expectedError = "unknown option '--resolve-safe-v1'";
            if (code !== 1 || !stderr.includes(expectedError)) {
              stream.stderr.write(`fixture: old CLI did not reject the protocol as expected (code=${code}): ${stderr}`);
              stream.exit(98);
              stream.end();
              return;
            }
            fs.writeFileSync(proofFile, `${process.env.SRP_OLD_VERSION}:${expectedError}\n`);
            stream.write(stdout);
            stream.exit(code);
            stream.end();
          } else {
            if (code !== 0) {
              // The current CLI must genuinely succeed first; a nonzero exit
              // here means the fixture's own setup is broken, not that the
              // transport-corruption path was exercised. Fail loudly.
              stream.stderr.write(`fixture: current CLI did not exit 0 (code=${code}): ${stdout}${stderr}`);
              stream.exit(97);
              stream.end();
              return;
            }
            // The real run succeeded; now simulate the peer emitting
            // malformed bytes over the wire despite its own exit 0.
            stream.write('{not-json');
            stream.exit(0);
            stream.end();
          }
        });
      });
    });
  });
  client.on('close', () => {
    fs.rmSync(shimDir, { recursive: true, force: true });
    server.close();
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`);
});
