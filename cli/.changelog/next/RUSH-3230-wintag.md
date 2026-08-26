- **The Windows helper's "asset missing" error names a tag that exists (RUSH-3230).**
  `downloadWinHelperExe` built its error message from `` `v${version}` `` — the CLI's tag
  shape — while the URL it had just tried came from `helperTag('computer-win', version)`.
  So a genuine 404 sent the reader looking for `v1.0.0`, which does not exist, instead of
  `computer-win/v1.0.0`, which does. The mac path was corrected when helpers moved to their
  own tags; the Windows path was left behind. Also drops a `getCliVersion` import that had
  no call site — the last trace of the old CLI-version coupling in that file.
  Source: `cli/src/lib/computer/ssh-tunnel.ts`.
