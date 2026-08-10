- **Fixed a Windows-only CI failure in the binary-shadow test.** `detectAgentsBinaryShadows`
  was already comparing files by identity, but its test still compared two path
  spellings through `fs.realpathSync`. On Windows `realpathSync` does not expand an
  8.3 short name, so a `where`-resolved path and one built from `os.tmpdir()` compare
  unequal even when they name the same file — which is why every PR touching
  `apps/cli` saw `windows` fail on a GitHub runner (`C:\Users\RUNNER~1\...` vs
  `C:\Users\runneradmin\...`). The test now identifies the file by basename plus
  contents, which is spelling-independent and asserts the stronger property.
