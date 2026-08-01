- **`release.sh` can now cut the next patch when main is ahead of an unpublishable
  version.** The catch-up guard refuses to publish a merged release PR whose squash pulled
  in concurrent main commits — correctly, since the tree that would ship is not the tree CI
  tested (the hole that let 1.20.58 publish before its Windows matrix failed). Its refusal
  advises cutting the next patch through the normal release PR flow, but the version
  validator measured patch+1 from the REGISTRY, so with main at 1.20.75 and npm at 1.20.74
  both 1.20.75 (blocked) and 1.20.76 (read as a skipped version) were rejected — leaving no
  patch-level path forward and a minor bump as the only escape. A new `patch-from-main`
  case accepts the version one patch above `package.json` when main is ahead of the
  registry; it grants no bypass, and the release still earns its own release PR, full
  cross-platform matrix, merge, tag, and publish. Source: `apps/cli/scripts/release.sh`.
