- **`agents browser profiles rename <from> <to>`.** A profile could not be
  renamed at all: `profiles edit` refuses a name change because the name keys the
  on-disk runtime dir, every endpoint/fork dir derived from it, and the
  `browser.profile` pointer. The only route was delete-and-recreate, which
  silently abandons the browser's `--user-data-dir` — where a profile's logins
  live. On a real agent browser that is gigabytes of session state and every
  account it has ever signed into. `rename` moves the config (staying in whichever
  store it already lives in), moves every cache dir belonging to the old name, and
  repoints both `browser.profile` and `browser.viewer` when either pointed there — a dangling `browser.viewer` sends every artifact back to the OS default handler, which is the exact bug the viewer seam was built to fix. Refuses while the profile is in
  use, because moving a `--user-data-dir` out from under a running browser
  corrupts it; refuses when the name exists in BOTH stores, since rewriting one
  would leave the other listed under the old name with its data already moved
  away; and validates every destination BEFORE moving any of them, so a
  collision on the second endpoint cannot strand the first one's logins under a
  name with no config entry. `os` joins `default` as a name a profile may not
  take — it is the reserved `browser.viewer` value meaning the OS handler. Source: `src/lib/browser/profiles.ts`, `src/commands/browser.ts`.
- **Profile-name validation is shared between `create` and `rename`.** The shape
  rule lived inline in `profiles create`, so a second caller would have accepted
  names `create` rejects. Now `assertRegistrableProfileName`, which also refuses
  `default` — the reserved alias meaning "this machine's configured profile"
  (RUSH-2709), not a name. Source: `src/lib/browser/profiles.ts`.
