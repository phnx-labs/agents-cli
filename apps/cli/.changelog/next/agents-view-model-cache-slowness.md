- **`agents view` no longer re-scans every installed Claude binary on each run.**
  When a Claude model extractor produced zero models (a broken regex, or a
  mid-install CLI), the result was never cached — so `getModelCatalog` re-ran a
  full `readFileSync` scan of the 230-270MB Claude binary for every affected
  installed version, on every invocation (~1.85s each). With 4 affected
  versions installed, that was ~7.5s added to every `agents view`. A 0-model
  extraction is now cached too, stamped with when it was attempted, and served
  for 24 hours before self-healing by retrying; an upgrade/reinstall (a new
  source mtime) still re-extracts immediately, as before. Measured on a real
  install with 7 Claude versions (4 of them hitting the broken extractor): the
  cold first-call cost (~12.5s, unavoidable) drops to ~1-2ms on every
  subsequent call. Source: `apps/cli/src/lib/models.ts`.
