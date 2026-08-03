#!/usr/bin/env node
/**
 * Real SSH2-protocol peer used by sessions.test.ts's two fleet-failure tests.
 *
 * Listens on 127.0.0.1 with an ephemeral port, accepts one real ssh connection
 * (any auth method — this is a throwaway loopback fixture, not a security
 * boundary), and on the exec channel runs the EXACT command string the real
 * `ssh` client sent (production's `bash -lc '...'`) through a real shell, with
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

/** A one-shot shim dir so the peer's `bash -lc` finds `agents` on PATH,
 * resolving to whichever CLI this mode needs to actually run. */
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resolver-ssh-shim-'));
const shimBin = path.join(shimDir, 'agents');
if (mode === 'old-peer') {
  fs.writeFileSync(
    shimBin,
    `#!/bin/sh\nexec env npm_config_cache='${path.join(peerHome, 'npm-cache')}' npx -y -p @phnx-labs/agents-cli@${process.env.SRP_OLD_VERSION} agents "$@"\n`,
  );
} else {
  fs.writeFileSync(
    shimBin,
    `#!/bin/sh\nexec ${process.execPath} --import '${process.env.SRP_TSX_LOADER}' '${process.env.SRP_CLI_ENTRY}' "$@"\n`,
  );
}
fs.chmodSync(shimBin, 0o755);

function runExecCommand(command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: peerHome,
      env: {
        ...process.env,
        HOME: peerHome,
        USERPROFILE: peerHome,
        PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
        NODE_NO_WARNINGS: '1',
      },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  // Loopback, single-use, throwaway keypair — accepting on the first
  // attempted method is a deliberate test-fixture simplification, not a
  // production auth policy.
  client.on('authentication', (ctx) => ctx.accept());
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept, _reject, info) => {
        const stream = accept();
        runExecCommand(info.command).then(({ code, stdout }) => {
          if (mode === 'old-peer') {
            // The real 1.20.88 CLI's own rejection IS the fixture — forward
            // its real exit code and (empty) stdout verbatim.
            stream.write(stdout);
            stream.exit(code ?? 1);
            stream.end();
          } else {
            if (code !== 0) {
              // The current CLI must genuinely succeed first; a nonzero exit
              // here means the fixture's own setup is broken, not that the
              // transport-corruption path was exercised. Fail loudly.
              stream.stderr.write(`fixture: current CLI did not exit 0 (code=${code}): ${stdout}`);
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
