- **`agents browser profiles rename <from> <to>`.** A profile could not be
  renamed at all: `profiles edit` refuses a name change because the name keys the
  on-disk runtime dir, every endpoint/fork dir derived from it, and the
  `browser.profile` pointer. The only route was delete-and-recreate, which
  silently abandons the browser's `--user-data-dir` — where a profile's logins
  live. On a real agent browser that is gigabytes of session state and every
  account it has ever signed into. `rename` moves the config (staying in whichever
  store it already lives in), moves every cache dir belonging to the old name, and
  repoints `browser.profile` when it pointed there. Refuses while the profile is in
  use, because moving a `--user-data-dir` out from under a running browser
  corrupts it. Source: `src/lib/browser/profiles.ts`, `src/commands/browser.ts`.
- **Profile-name validation is shared between `create` and `rename`.** The shape
  rule lived inline in `profiles create`, so a second caller would have accepted
  names `create` rejects. Now `assertRegistrableProfileName`, which also refuses
  `default` — the reserved alias meaning "this machine's configured profile"
  (RUSH-2709), not a name. Source: `src/lib/browser/profiles.ts`.
