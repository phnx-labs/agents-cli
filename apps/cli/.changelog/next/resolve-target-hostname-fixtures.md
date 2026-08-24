- **Fixed: `resolve-target.test.ts` failed on any machine actually named `mac-mini` or `zion`.** The
  fixtures wrote device declarations for two real fleet hostnames and then asserted the resolver
  would tunnel to them. On a box with that `machineId()` the resolver correctly reports the profile
  as locally declared, so the tunnel assertions failed — green on Linux CI, red on both Macs, which
  is where releases run. The suite is now hermetic: fixtures use `peer-alpha`/`peer-zulu`, keeping
  the sort order the "first reachable declaring device" assertions depend on.
  Source: `src/lib/browser/resolve-target.test.ts`.
