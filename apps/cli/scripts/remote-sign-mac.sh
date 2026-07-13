#!/usr/bin/env bash
#
# Offload the macOS native-helper build + codesign + notarize to a headless Mac
# so an agents-cli release can be DRIVEN FROM A LINUX BOX.
#
# The published tarball bundles two signed macOS .app helpers that Linux cannot
# produce:
#   - bin/Agents CLI.app   — the keychain helper (swiftc universal → codesign
#                            with entitlements + embedded provisioning profile →
#                            notarize → staple). See build-keychain-helper.sh.
#   - bin/MenubarHelper.app — the menu-bar status item (swift build → codesign,
#                            NO notarization). See menubar/scripts/build.sh.
#
# This script rsyncs the exact build INPUTS from THIS worktree to a dedicated
# sign host ("mac-mini"), runs the two Mac build scripts there under the
# appliance's headless signing creds, then pulls the signed bundles back into
# THIS worktree's apps/cli/bin/ so `bun run build` (now presence-gated, not
# uname-gated) can package them and `npm publish` can run anywhere.
#
# Env knobs:
#   SIGN_HOST        sign host (default: mac-mini) — must be ssh/scp reachable.
#   SIGN_HOST_REPO   agents-cli checkout on the sign host. $HOME is resolved on
#                    the REMOTE side (default: $HOME/src/github.com/muqsitnawaz/agents-cli).
#
# The sign host must have: a Developer ID identity in rush-signing.keychain-db,
# the kcpass + secrets.pass files under ~/Library/Application Support/rush/, the
# `apple.com` secrets bundle (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
# APPLE_TEAM_ID), and — for the keychain helper only — bin/embedded.provisionprofile
# (rsynced from here if present locally, otherwise the host's own copy is used).
#
# Usage: scripts/remote-sign-mac.sh
set -euo pipefail

SIGN_HOST="${SIGN_HOST:-mac-mini}"
SIGN_HOST_REPO="${SIGN_HOST_REPO:-\$HOME/src/github.com/muqsitnawaz/agents-cli}"

# apps/cli in THIS worktree (script lives in apps/cli/scripts/).
LOCAL_CLI="$(cd "$(dirname "$0")/.." && pwd)"

log()  { printf '\033[36m[remote-sign]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[remote-sign]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[remote-sign] error:\033[0m %s\n' "$*" >&2; exit 1; }

command -v ssh   >/dev/null || die "ssh not found"
command -v rsync >/dev/null || die "rsync not found"

log "sign host:        $SIGN_HOST"
log "local apps/cli:   $LOCAL_CLI"

# Resolve the remote build workspace. SIGN_HOST_REPO carries a literal '$HOME'
# that only the REMOTE shell may expand, so echo it there and capture the result.
HOST_CLI="$(ssh "$SIGN_HOST" "echo ${SIGN_HOST_REPO}/apps/cli")" \
  || die "could not reach $SIGN_HOST over ssh"
[[ -n "$HOST_CLI" ]] || die "resolved an empty remote apps/cli path"
log "remote apps/cli:  $SIGN_HOST:$HOST_CLI"

# ----- 1. Ship the build inputs from this worktree to the sign host -----
# We stage into the sign host's apps/cli subtree so the Mac build scripts see the
# layout they expect (scripts/.., src/lib/secrets/.., menubar/..). This is a build
# workspace, not a git checkout — the sign host's own branch/version is irrelevant.
log "staging build inputs on $SIGN_HOST ..."
ssh "$SIGN_HOST" "mkdir -p '$HOST_CLI/src/lib/secrets' '$HOST_CLI/scripts' '$HOST_CLI/bin' '$HOST_CLI/menubar'"

# Full src tree + package manifest: the standalone CLI binary is compiled from
# src/ with `bun build --compile` (scripts/build-bin.sh), which resolves its
# npm imports from node_modules — the remote script runs `bun install` first.
rsync -az --delete --exclude '__tests__/' --exclude '*.test.ts' \
          "$LOCAL_CLI/src/" "$SIGN_HOST:$HOST_CLI/src/"
rsync -az "$LOCAL_CLI/package.json" "$LOCAL_CLI/bun.lock" "$SIGN_HOST:$HOST_CLI/"
rsync -az "$LOCAL_CLI/scripts/keychain-entitlements.plist" \
          "$LOCAL_CLI/scripts/build-keychain-helper.sh" \
          "$LOCAL_CLI/scripts/build-bin.sh" \
          "$LOCAL_CLI/scripts/sign-cli-binary.sh" \
          "$LOCAL_CLI/scripts/bun-jit-entitlements.plist" \
          "$SIGN_HOST:$HOST_CLI/scripts/"
# Menu-bar Swift package — exclude build outputs so we don't ship stale artifacts.
rsync -az --delete --exclude '.build/' --exclude 'dist/' \
          "$LOCAL_CLI/menubar/" "$SIGN_HOST:$HOST_CLI/menubar/"

if [[ -f "$LOCAL_CLI/bin/embedded.provisionprofile" ]]; then
  rsync -az "$LOCAL_CLI/bin/embedded.provisionprofile" "$SIGN_HOST:$HOST_CLI/bin/"
  log "shipped local bin/embedded.provisionprofile"
else
  log "no local provisioning profile — relying on the sign host's own copy"
fi
ok "inputs staged"

# ----- 2. Build + sign (+ notarize the keychain helper) on the sign host -----
# Runs under a login shell so `agents` is on PATH, unlocks the signing keychain
# headless, and injects the Apple notarization creds via the `apple.com` bundle.
# The menu-bar helper is built FIRST: it needs no external prerequisites, so a
# misconfigured sign host still yields the (reliably signable) menu-bar bundle
# before failing loudly on the keychain helper, which additionally requires the
# provisioning profile + a notarization round-trip.
log "building + signing on $SIGN_HOST (menu-bar helper, then keychain helper + notarize) ..."

# Generate the remote build script LOCALLY and ship it as a file, then run it on
# the host. A file dodges the multi-layer quoting hell of embedding a multi-line
# script (with its own single-quoted `bash -c '...'`) inside an ssh command that
# the host's login shell re-parses. `$HOME` / `$(cat …)` stay literal so the
# REMOTE bash expands them; only the resolved workspace path is baked in via %q.
BUILD_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/remote-sign-build.XXXXXX.sh")"
trap 'rm -f "$BUILD_SCRIPT"' EXIT
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\ncd %q\n' "$HOST_CLI"
  cat <<'REMOTE_EOF'
# Unlock the signing keychain headless, then inject the Apple notary creds.
security unlock-keychain -p "$(cat "$HOME/Library/Application Support/rush/signing.kcpass")" rush-signing.keychain-db
export AGENTS_SECRETS_PASSPHRASE="$(cat "$HOME/Library/Application Support/rush/secrets.pass")"
agents secrets exec apple.com -- bash -c '
  set -euo pipefail
  echo "== menu-bar helper: swift build + codesign =="
  menubar/scripts/build.sh release
  # rm -rf first so a re-run does not nest the new .app INSIDE a stale
  # bin/MenubarHelper.app (cp -R into an existing dir), which corrupts the
  # signature ("unsealed contents present in the bundle root").
  rm -rf bin/MenubarHelper.app
  cp -R menubar/dist/MenubarHelper.app bin/MenubarHelper.app
  codesign --verify --deep --strict "bin/MenubarHelper.app"
  echo "== keychain helper: swiftc + codesign + notarize =="
  scripts/build-keychain-helper.sh
  echo "== pin sha256 of the notarized keychain binary =="
  shasum -a 256 "bin/Agents CLI.app/Contents/MacOS/Agents CLI" > "scripts/Agents CLI.app.sha256"
  cat "scripts/Agents CLI.app.sha256"
  echo "== standalone agents binary: bun build + codesign + notarize =="
  bun install --frozen-lockfile
  scripts/sign-cli-binary.sh
'
REMOTE_EOF
} > "$BUILD_SCRIPT"

rsync -az "$BUILD_SCRIPT" "$SIGN_HOST:$HOST_CLI/.remote-sign-build.sh"
# `bash -lc` gives the run `agents` on PATH (homebrew); `bash <file>` avoids
# needing the staged script to be +x.
ssh "$SIGN_HOST" "bash -lc 'bash \"$HOST_CLI/.remote-sign-build.sh\"'" \
  || die "remote build/sign failed on $SIGN_HOST (see output above)"
ok "remote build + sign complete"

# ----- 3. Pull the signed bundles + refreshed sha pin back into this worktree -----
log "pulling signed bundles back into $LOCAL_CLI/bin/ ..."
mkdir -p "$LOCAL_CLI/bin"
rsync -az --delete "$SIGN_HOST:$HOST_CLI/bin/Agents CLI.app"   "$LOCAL_CLI/bin/"
rsync -az --delete "$SIGN_HOST:$HOST_CLI/bin/MenubarHelper.app" "$LOCAL_CLI/bin/"
rsync -az "$SIGN_HOST:$HOST_CLI/scripts/Agents CLI.app.sha256" "$LOCAL_CLI/scripts/Agents CLI.app.sha256"
rsync -az "$SIGN_HOST:$HOST_CLI/bin/agents-macos" "$LOCAL_CLI/bin/agents-macos"
rsync -az "$SIGN_HOST:$HOST_CLI/scripts/agents-cli-bin.sha256" "$LOCAL_CLI/scripts/agents-cli-bin.sha256"
ok "bundles pulled back"

# ----- 4. Local sanity: recompute the sha over the pulled Mach-O and assert match -----
if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL=(shasum -a 256)
else
  SHA_TOOL=(sha256sum)
fi
expected="$(cut -d ' ' -f 1 "$LOCAL_CLI/scripts/Agents CLI.app.sha256")"
actual="$("${SHA_TOOL[@]}" "$LOCAL_CLI/bin/Agents CLI.app/Contents/MacOS/Agents CLI" | cut -d ' ' -f 1)"
[[ "$actual" == "$expected" ]] \
  || die "keychain helper sha mismatch after pull-back: expected $expected, got $actual"
ok "keychain helper sha verified: $actual"

[[ -d "$LOCAL_CLI/bin/MenubarHelper.app" ]] || die "menu-bar helper bundle missing after pull-back"
ok "menu-bar helper bundle present: bin/MenubarHelper.app"

# Same integrity assert for the standalone CLI binary (issue #315): the pulled
# bin/agents-macos must match the sha pin its sign run produced.
expected_cli="$(cut -d ' ' -f 1 "$LOCAL_CLI/scripts/agents-cli-bin.sha256")"
actual_cli="$("${SHA_TOOL[@]}" "$LOCAL_CLI/bin/agents-macos" | cut -d ' ' -f 1)"
[[ "$actual_cli" == "$expected_cli" ]] \
  || die "standalone agents binary sha mismatch after pull-back: expected $expected_cli, got $actual_cli"
ok "standalone agents binary sha verified: $actual_cli"

ok "signed bundles ready in $LOCAL_CLI/bin — 'bun run build' will package them."
