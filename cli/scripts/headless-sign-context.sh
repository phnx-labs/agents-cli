#!/usr/bin/env bash
#
# The headless signing + secrets context for the release home base (mac-mini).
#
# SOURCE this (do not exec it) from a shell already on the home base, before any
# signing or secret resolution, so the run is fully headless -- NO Touch ID, NO
# per-secret prompt:
#   - unlocks the Developer ID signing keychain (rush-signing.keychain-db) from
#     its on-disk pass file, so codesign/notarytool can use the identity; and
#   - exports AGENTS_SECRETS_PASSPHRASE from its on-disk pass file, so
#     `agents secrets exec <bundle> -- …` (apple.com for notarization creds,
#     npmjs.com for the publish token) resolves silently.
#
# This is the single source of truth for that preamble, shared by:
#   - release.sh's run_home_base_phase (build + sign + npm publish, run locally
#     on the home base), and
#   - remote-sign-mac.sh's remote build script (build + pull-back only).
#
# Usage (from a home-base shell):  . scripts/headless-sign-context.sh
set -euo pipefail

_RUSH_SUPPORT="$HOME/Library/Application Support/rush"

if [[ -f "$_RUSH_SUPPORT/signing.kcpass" ]]; then
  _kcpass="$(cat "$_RUSH_SUPPORT/signing.kcpass")"
  security unlock-keychain -p "$_kcpass" rush-signing.keychain-db
  # Authorize codesign/apple-tool to use the Developer ID key non-interactively.
  # Without this the key ACL prompts for UI approval, which a headless SSH
  # release session cannot answer -- codesign then fails with
  # errSecInternalComponent. Idempotent; safe to run every release.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$_kcpass" \
    rush-signing.keychain-db >/dev/null 2>&1 || true
  unset _kcpass
fi
if [[ -f "$_RUSH_SUPPORT/secrets.pass" ]]; then
  AGENTS_SECRETS_PASSPHRASE="$(cat "$_RUSH_SUPPORT/secrets.pass")"
  export AGENTS_SECRETS_PASSPHRASE
fi
