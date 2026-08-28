#!/usr/bin/env bash
# Read-only readiness probe for the PROMOTE home base (RUSH-3026).
#
# The home-base phase is promote-only: download the attested tarball, verify,
# install-smoke, npm publish, re-attach the reused helper zip. Nothing on that
# path signs or notarizes, so this probe checks exactly what promoting needs —
# tool presence, gh auth, and a headlessly readable npmjs.com NPM_TOKEN — and
# deliberately NOT signing provisioning (cert/keychain/provisionprofile). Helper
# signing has its own path (scripts/signing-home-base-probe.sh remains the
# provisioning checker for that) and runs only when helper sources change.
#
# `secrets exec ... test -n` proves the token resolves WITHOUT printing it; a
# locked keychain or missing bundle fails here, before the release's first
# mutation, instead of after merge+tag (the RUSH-2535 shape).
#
# Runs on the home base: inline when the release is invoked there, else piped
# over `agents ssh <home-base> bash -s` by assert_promote_home_base.
#
# $1 (optional) is the --deploy-worker mode (auto|on|off, default off). When it is
# not `off`, the probe ALSO verifies this box can deploy the managed share Worker
# after publish (PHNX-3403): the share endpoint must be configured here and the
# cloudflare.com API token must resolve headlessly — checked BEFORE the release's
# first mutation so a Worker-touching release can't publish and then discover it
# cannot deploy. Pass --deploy-worker=off to release without this requirement.
set -u

DEPLOY_WORKER="${1:-off}"

fail() { echo "promote-probe: $*" >&2; exit 1; }

command -v npm  >/dev/null 2>&1 || fail "npm not on PATH"
command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v git  >/dev/null 2>&1 || fail "git not on PATH"
command -v jq   >/dev/null 2>&1 || fail "jq not on PATH"
command -v gh   >/dev/null 2>&1 || fail "gh not on PATH (release-asset attach)"
command -v agents >/dev/null 2>&1 || fail "agents CLI not on PATH (npmjs.com token injection)"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated"
agents secrets exec npmjs.com -- sh -c 'test -n "$NPM_TOKEN"' >/dev/null 2>&1 \
  || fail "npmjs.com bundle NPM_TOKEN is not readable headlessly (agents secrets add npmjs.com NPM_TOKEN, file-backed)"

if [[ "$DEPLOY_WORKER" != "off" ]]; then
  agents artifacts share status >/dev/null 2>&1 \
    || fail "share endpoint not configured on this home base (run 'agents artifacts share join'), required for --deploy-worker=$DEPLOY_WORKER; provision it or release with --deploy-worker=off"
  agents secrets exec cloudflare.com -- sh -c 'test -n "${CLOUDFLARE_API_TOKEN:-}${CF_API_TOKEN:-}"' >/dev/null 2>&1 \
    || fail "cloudflare.com bundle API token not readable headlessly (agents secrets add cloudflare.com CLOUDFLARE_API_TOKEN, file-backed), required for --deploy-worker=$DEPLOY_WORKER; provision it or release with --deploy-worker=off"
fi

echo "promote-ready"
