- **Balanced routing no longer launches into an account it only *thinks* has
  headroom.** Account usage is cached per machine under stale-while-revalidate:
  a snapshot up to 24h old was served instantly, and the background refresh that
  should have corrected it lands after the pick is already made. On a box whose
  refresh is failing that state is permanent — measured on `yosemite-s1`, every
  Claude snapshot sat 26 hours to 2.7 days old, so balanced read
  `muqsit@getrush.ai` as 48% used and launched into it while the account was at
  its weekly cap; the session answered "You've hit your weekly limit" on its
  first turn. Routing now caps how stale a snapshot may be when it is about to
  decide (5 minutes), blocking on one bounded, parallel live read past that — and
  no read at all inside the existing 2-minute fresh window, which back-to-back
  launches hit. Display paths (`agents view`) keep the full 24h window and stay
  off the network.
- **A pick made on unconfirmed data says so.** When no account on the machine
  could be refreshed, routing still launches — a broken refresh must not make a
  box unusable — but the banner now reads `… (2 of 5 healthy, usage unverified —
  no account could be refreshed)` instead of presenting a guess as a fact. An
  account with a verified snapshot always wins over one with a stale snapshot,
  even when the stale number looks emptier.
