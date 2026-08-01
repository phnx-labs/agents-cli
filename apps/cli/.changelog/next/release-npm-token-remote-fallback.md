- **`release.sh` now borrows the npm token from a primary device when the local box
  has none, so a Linux-driven release stops asking a human to approve a token.**
  Token resolution was env → local `npmjs.com` bundle → *die*. On a fleet box whose
  own keychain holds no npm token, that dead end pushed agents to hand-move a
  credential between machines (and correctly get gated on it). A third step now
  resolves the bundle **ephemerally from a primary device over SSH** —
  `agents secrets exec npmjs.com --host <host>`, which resolves on the remote and
  injects into the run only, never storing the token locally. It tries `SECRET_HOST`
  first, then `zion`, then `mac-mini`, and fails with the list it tried if none
  answer. Combined with the sign-host auto-discovery, a Linux box can now cut a full
  release end-to-end given a reachable Mac for signing and any reachable device that
  holds the npm token. Source: `apps/cli/scripts/release.sh`.
