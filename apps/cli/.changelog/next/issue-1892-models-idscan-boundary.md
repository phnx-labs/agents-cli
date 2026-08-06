- **`agents models claude` no longer lists bare legacy ids that 404 (#1892).** The
  native-binary id-scan fallback (`scanClaudeCatalogIds`, used when the curated maps
  come up empty) is now word-boundary anchored and matches the id body atomically, so
  it can't scrape a bare-major prefix (`claude-sonnet-4`) out of the binary's own dotted
  `claude-sonnet-4.6` "Typo in model ID" troubleshooting string, out of a suffix-glued
  token (`claude-opus-4-1x`), or out of a token glued to a preceding identifier char. The
  existing `dropBareLegacyIds` sibling-drop still removes the standalone
  `.includes("claude-opus-4")` prefix-check artifacts; genuine bare currents
  (`claude-sonnet-5`) are kept. Catalog output is unchanged across all shipped Claude
  binaries. Source: `apps/cli/src/lib/models.ts`.
