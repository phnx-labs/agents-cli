/**
 * macOS SUN_LEN-safe CODEX_HOME resolution.
 *
 * Codex reads its config (approval_policy, sandbox_mode, MCP servers, rules)
 * from CODEX_HOME and, for its app-server daemon, binds a Unix-domain control
 * socket at `$CODEX_HOME/app-server-control/app-server-control.sock`. macOS
 * caps Unix socket paths at 104 bytes (SUN_LEN — `sizeof(sockaddr_un.sun_path)`
 * in `<sys/un.h>`). agents-cli points CODEX_HOME at the deep versioned home
 * (`~/.agents/.history/versions/codex/<version>/home/.codex`), which for a
 * typical user is long enough that the derived socket path exceeds 104 bytes.
 * `codex app-server daemon start` then fails with `path must be shorter than
 * SUN_LEN`, and every codex spawn on macOS dies (this took down all OpenClaw
 * agents on mac-mini — RUSH-1866).
 *
 * Codex exposes no socket-path override and resolves symlinks before binding,
 * so a short symlink pointing at the deep home does NOT help (the socket lives
 * at the resolved target). The only fix is to make the *real* CODEX_HOME short.
 * On macOS, when the versioned home's socket path would overflow, we relocate
 * the home once to a short real directory under `~/.agents/.codex-homes/` and
 * leave a symlink behind at the versioned path, then point CODEX_HOME at the
 * short real path. Config, auth, and state migrate intact; there is no socket
 * or sqlite fragmentation because a single physical home simply moves.
 *
 * This module is the single source of truth for that logic. `exec.ts` calls
 * the TS resolver for `agents run`/`agents exec`; `shims.ts` emits the bash
 * equivalent (`codexHomeShimBash`) into the generated codex shims. Keep the two
 * in lockstep.
 */
import * as fs from 'fs';
import * as path from 'path';

/** macOS Unix-domain socket path cap: `sizeof(sockaddr_un.sun_path)` in <sys/un.h>. */
export const SUN_LEN = 104;

/** Suffix codex appends to CODEX_HOME to reach its app-server control socket. */
export const CODEX_CONTROL_SOCKET_SUFFIX = '/app-server-control/app-server-control.sock';

/**
 * True when this CODEX_HOME's derived control-socket path would overflow
 * SUN_LEN on macOS.
 */
export function codexHomeOverflowsSunLen(home: string): boolean {
  return home.length + CODEX_CONTROL_SOCKET_SUFFIX.length > SUN_LEN;
}

/**
 * The short, per-version codex home used when the versioned home overflows.
 * `~/.agents/.codex-homes/<version>/.codex` keeps the socket path well under
 * SUN_LEN while staying stable across reboots (unlike $TMPDIR) and per-version
 * isolated.
 */
export function shortCodexHome(agentsUserDir: string, version: string): string {
  return path.join(agentsUserDir, '.codex-homes', version, '.codex');
}

/**
 * Resolve a macOS SUN_LEN-safe CODEX_HOME for the given versioned home,
 * migrating the home to a short real path (once, idempotently) when needed.
 *
 * On non-darwin platforms, or when the versioned home already fits, the
 * versioned home is returned unchanged. If migration fails for any reason the
 * versioned home is returned (no worse than the pre-fix behavior).
 */
export function resolveCodexHome(
  versionedHome: string,
  agentsUserDir: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'darwin') return versionedHome;
  if (!codexHomeOverflowsSunLen(versionedHome)) return versionedHome;

  const short = shortCodexHome(agentsUserDir, version);
  try {
    if (!fs.existsSync(short)) {
      fs.mkdirSync(path.dirname(short), { recursive: true });
      const st = fs.lstatSync(versionedHome, { throwIfNoEntry: false });
      if (st && st.isDirectory() && !st.isSymbolicLink()) {
        // Migrate the existing deep home so config/auth/state stay intact,
        // then leave a symlink so anything referencing the versioned path
        // still resolves.
        fs.renameSync(versionedHome, short);
        fs.symlinkSync(short, versionedHome);
      } else if (!st) {
        // Fresh install: create the short home and link the versioned path to it.
        fs.mkdirSync(short, { recursive: true });
        fs.symlinkSync(short, versionedHome);
      }
      // If versionedHome is already a symlink (migrated by a prior run or the
      // shim), leave it; `short` will be populated below.
    }
  } catch {
    // Migration lost a race or hit a permission error. Fall back to the
    // versioned home rather than crash the invocation.
    if (!fs.existsSync(short)) return versionedHome;
  }
  return fs.existsSync(short) ? short : versionedHome;
}

/**
 * Emit the bash block that a generated codex shim uses to export a
 * SUN_LEN-safe CODEX_HOME. Mirrors {@link resolveCodexHome}.
 *
 * @param homeExpr      shell expression for the versioned codex home
 *                      (e.g. `$VERSION_DIR/home/.codex`)
 * @param shortBaseExpr shell expression for the per-version short base dir
 *                      (e.g. `$AGENTS_USER_DIR/.codex-homes/$VERSION`)
 */
export function codexHomeShimBash(homeExpr: string, shortBaseExpr: string): string {
  return `
# Codex reads its config (approval_policy, sandbox_mode, MCP servers, rules)
# from CODEX_HOME and binds a Unix control socket at
# "\$CODEX_HOME/app-server-control/app-server-control.sock" for its app-server
# daemon. macOS caps Unix socket paths at 104 bytes (SUN_LEN); the deep
# versioned home overflows, so "codex app-server daemon start" fails with
# "path must be shorter than SUN_LEN" and every codex spawn dies (RUSH-1866).
# Codex has no socket-path override and resolves symlinks before binding, so a
# short symlink to the deep home does NOT help. On macOS, when the derived
# socket path would overflow, relocate the home once to a short real dir and
# leave a symlink behind, then point CODEX_HOME at the short real path. A
# caller-provided CODEX_HOME always wins.
if [ -z "\${CODEX_HOME:-}" ]; then
  CODEX_HOME="${homeExpr}"
  # 43 = length of "/app-server-control/app-server-control.sock"; 104 = SUN_LEN.
  if [ "\$(uname -s)" = "Darwin" ] && [ "\$(( \${#CODEX_HOME} + 43 ))" -gt 104 ]; then
    _codex_short="${shortBaseExpr}/.codex"
    if [ ! -e "\$_codex_short" ]; then
      mkdir -p "${shortBaseExpr}"
      if [ -d "\$CODEX_HOME" ] && [ ! -L "\$CODEX_HOME" ]; then
        if mv "\$CODEX_HOME" "\$_codex_short" 2>/dev/null; then
          ln -snf "\$_codex_short" "\$CODEX_HOME"
        fi
      elif [ ! -e "\$CODEX_HOME" ]; then
        mkdir -p "\$_codex_short"
        ln -snf "\$_codex_short" "\$CODEX_HOME"
      fi
    fi
    [ -d "\$_codex_short" ] && CODEX_HOME="\$_codex_short"
  fi
fi
export CODEX_HOME="\$CODEX_HOME"
`;
}
