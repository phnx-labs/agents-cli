- **The compiled binary no longer reports itself as a phantom `/$bunfs` install, and can self-upgrade again.**
  Since the standalone executable started shipping (1.20.53), the running copy located
  its own package root as `<__dirname>/..`. Under a Bun standalone binary `__dirname`
  is the embedded virtual filesystem, so that resolved to `/$bunfs` — a path that
  exists nowhere. Two symptoms followed on every machine running the compiled binary:
  the multi-install check reported one install as two (`/$bunfs (running)` alongside
  the real npm root, with the misleading advice to uninstall a stale copy that did not
  exist), and `agents upgrade` failed closed with `/$bunfs is not an npm-managed
  install` because no global prefix can be derived from a virtual path. A new
  `resolveRunningPackageRoot()` resolves the real on-disk root by walking up from
  `process.execPath` to the directory whose `package.json` names this package, and
  both sites use it. The PATH scan also recognizes `<root>/dist/bin/agents` as an
  entrypoint, so a shim pointing at the compiled binary — typically first on PATH, and
  the copy that actually runs — resolves to the same root as its sibling npm bin
  instead of being invisible. Genuine multi-install warnings still fire, now naming a
  real, actionable path. Source: `apps/cli/src/lib/self-update.ts`,
  `apps/cli/src/index.ts`, `apps/cli/src/lib/self-update.test.ts`.
