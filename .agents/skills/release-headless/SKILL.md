---
name: release-headless
description: >-
  Gotchas for the agents-cli headless release. The macOS home base signs,
  notarizes, and npm-publishes over SSH with no GUI and no Touch ID — three
  things must be primed or the release stalls. Triggers on: release stuck at
  sign/publish, errSecInternalComponent, "no npmjs.com bundle", "Missing
  embedded.provisionprofile", making the release autonomous.
user-invocable: true
version: 1.0.0
author: muqsit
---

# Headless release — home-base gotchas

`apps/cli/scripts/release.sh` orchestrates from any fleet box (Linux included) but
routes the privileged phase — build + sign + notarize + `npm publish` — to the
macOS **home base** over SSH. That phase runs with **no GUI session and no Touch
ID**, so three things must be primed. When a release dies after "CI all-green,
merged, tagged" but nothing lands on npm, it is almost always one of these.

Everything below is host-agnostic: resolve the home base from the release script,
never hardcode a path.

## 1. Secrets bundles must be unlocked (locked ≠ empty)

The home base reads two file-backed secret bundles headlessly:
- `npmjs.com` → `NPM_TOKEN` (the publish token)
- `apple.com` → `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_NAME` (notarization)

They are decrypted with `AGENTS_SECRETS_PASSPHRASE`, which `headless-sign-context.sh`
loads from an on-disk pass file. **The failure mode:** if a bundle was re-encrypted
with a different passphrase (drift), or is simply locked, a headless
`agents secrets export <bundle> --plaintext` returns **empty** — and the release
reports `no 'npmjs.com' secrets bundle on <home base>`, which looks identical to the
bundle being missing.

- **Diagnose, don't assume.** A `0 keys` listing over SSH can mean **locked**, not
  empty. Check for the encrypted blob on disk (`agents-cli.bundles.<name>.enc`) — if
  it exists, the bundle is real and just unreadable headlessly. `AGENTS_SECRETS_PASSPHRASE=<pass> agents secrets export <name> --plaintext` tells you whether it is a passphrase mismatch (0) or a good decrypt (N keys).
- **Fix:** on the home base, `agents secrets unlock npmjs.com apple.com`. Interactive
  Touch ID works there; the unlock holds ~7 days and is **global**, so a subsequent
  headless SSH read (and the release) can then decrypt it. Do **not** try to unlock
  over SSH — no biometry prompt is available headlessly.
- Do not "fix" this by deleting + recreating the bundle blind: the token/creds are
  re-exportable from another box that already holds them
  (`agents secrets export <name> --host <home base>`), but the real problem is the
  lock state, not missing data.

## 2. The signing keychain ACL must grant codesign (errSecInternalComponent)

Codesign over pure SSH fails with **`errSecInternalComponent`** when the Developer ID
private key's ACL requires interactive approval — there is no GUI session to answer
it. The fix is **not** a GUI login; it is granting codesign non-interactive access:

- `headless-sign-context.sh` unlocks the signing keychain **and** runs
  `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <pass> <keychain>`.
  That partition-list grant is **persistent** in the keychain, so once primed it
  survives across releases.
- If codesign still fails on a fresh/reset box, the ACL prime did not take. It can
  only be authorized from a session that can reach the key. The durable, box-agnostic
  cure is the CI-standard recipe: store the Developer ID as a `.p12` secret and have
  the context **import it into a fresh keychain each run** with
  `security import … -T /usr/bin/codesign` + `set-key-partition-list` — then no
  pre-existing keychain state has to survive a reboot. (The identity `.p12` exports
  headlessly, so this needs no GUI step to set up.)
- Symptom-to-cause: `errSecInternalComponent` is a **keychain/ACL** problem, never a
  cert-chain or notarization problem. Do not chase the cert.

## 3. The build runs from a fresh worktree of the tag — gitignored inputs are absent

The home-base phase does `git worktree add --detach <wt> v<version>` and builds
there. **Anything the build needs that is gitignored is not in that worktree.** The
concrete case: the keychain helper needs `apps/cli/bin/embedded.provisionprofile`,
but `/apps/cli/bin/` is gitignored — so the profile lives only in the home base's
main checkout, and the worktree build dies with
`Missing … embedded.provisionprofile. Generate at developer.apple.com and check it in`.

- `release.sh` copies the profile from the home base's checkout into the worktree
  after creating it. If you add another gitignored build input, copy it in the same
  place — do not assume the worktree has it.
- General rule: the tag's tree is the source of truth for the build **except** for
  gitignored signing inputs, which must be injected from the home base's checkout.

## 4. The published tree is the CI-tested tree, not main's HEAD

On a busy default branch, unrelated PRs merge during a release PR's CI window, so the
squash-merge lands on a newer base and its tree diverges from what CI tested.
`release.sh` (via `select-publish-commit.sh`) detects this and tags + publishes the
**CI-tested release commit** (the PR head the full matrix went green on), not the
drifted merge — the intervening commits ride the next release. So a `v<version>` tag
can legitimately point at a commit that is not on the default branch's first-parent
line. This is by design; do not "fix" it by re-pointing the tag at main.

## The mental model

`merged → tagged → **home-base phase**` is where autonomy lives or dies. The home
base is the one box with npm-publish rights + the Developer ID cert, so the privileged
phase always routes there regardless of the trigger box. Making that phase truly
zero-touch means: bundles unlocked (1), keychain ACL primed (2), gitignored signing
inputs injected into the build worktree (3). Get those three right and a Linux box can
drive the whole release end to end.
