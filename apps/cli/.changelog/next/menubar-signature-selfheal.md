- **The menu-bar helper no longer crash-loops on macOS 26.** npm's pack/extract
  strips the ad-hoc signature the release bakes into `MenubarHelper.app`, leaving
  it `code object is not signed at all`. macOS 26's code-signing monitor SIGKILLs
  an unsigned binary at launch (`SIGKILL (Code Signature Invalid)`), so under the
  launchd `KeepAlive` service it restarted forever, and its unstable identity made
  the Accessibility grant (needed for the clip→paste keystroke in `Clip.swift`)
  re-prompt every time. The install path now re-signs the copied bundle ad-hoc and
  verifies it before bootstrapping the service, so every machine gets a valid
  signature the kernel accepts — and a bundle that can't be made valid is skipped
  instead of spun in a crash loop. A Developer-ID-signed helper (which survives
  npm) is left untouched. Source: `apps/cli/src/lib/menubar/install-menubar.ts`,
  `apps/cli/menubar/scripts/build.sh`.
