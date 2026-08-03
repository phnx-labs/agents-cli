- **A usage read that fails on the credential now says so, instead of returning
  a silent null.** Two branches in the Claude usage fetch — no readable
  credential, and a locally-expired one — returned `{ snapshot: null, error:
  null }`. The caller could not tell that apart from a healthy read, so it fell
  back to whatever the stale-while-revalidate cache held and drew those bars as
  fact. Measured on `yosemite-s1`: every Claude account's stored access token had
  expired (one of them eleven days earlier), so no read could succeed, and
  `agents view claude --refresh` printed a full, healthy-looking table twice
  while writing nothing to the cache. A usage read never refreshes a token
  (RUSH-1822), so neither state heals on its own — the account stays unreadable
  until a real `claude` run rotates the credential.
- **`agents view` marks bars the live read could not confirm.** A row whose
  snapshot came from the cache after a failed live read renders the reading plus
  `unverified`, rather than looking identical to a confirmed one. The number
  still shows — it is the last thing we saw — but it no longer reads as current.
- **`agents view --refresh` reports what it could not refresh.** It now lists
  each account it failed to reach and why, instead of rendering a table that
  looks fully refreshed regardless.
