- **The multi-install warning now inventories copies outside `PATH` and flags
  legacy installs that can corrupt the shared macOS helper bundle (#2147).**
  Discovery covers NVM, fnm, Volta, Bun, common npm global prefixes, and npm's
  `_npx` cache in addition to resolving every `agents` entry on `PATH`. Dev
  installs are no longer hidden: a copy without the atomic
  `app-bundle-install` module is labelled `unsafe legacy helper installer —
  remove this copy`, because invoking it can still replace a live `.app` with a
  partial bundle. Source: `apps/cli/src/lib/self-update.ts`,
  `apps/cli/src/index.ts`.
