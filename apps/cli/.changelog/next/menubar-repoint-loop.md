- **Two agents-cli installs no longer fight over the menu-bar helper.** On a box with
  more than one install (e.g. a Homebrew npm global plus `npm i -g --prefix ~/.local`),
  the startup self-heal reinstalled the helper on *every* `agents` invocation: both the
  version stamp and the plist's baked `AGENTS_ENTRY` name whichever copy invoked last,
  so each copy saw drift and recopied the app bundle over the other's. Recopying replaces
  the executable under the running helper and kills it, launchd `KeepAlive` restarts it,
  and the other install repeats it — a new pid every 5-15 seconds, 578 launches in one
  observed helper log, and a status item that never stayed visible while
  `agents menubar status` still reported `running: yes` (because some pid always existed).
  Skew alone no longer tears down a live helper: only a genuinely different helper binary
  (a real upgrade, compared by content rather than by version string) or a signing-identity
  heal does. Pure version/entry skew now refreshes the plist and version stamp in place, so
  the next natural launch picks up the current install and nothing is killed. Same rule
  #909 applied to the secrets broker (`shouldTeardownVersionSkewedBroker`), which had the
  identical failure on the identical pair of prefixes (#435). Fixes #2109. Source:
  `apps/cli/src/lib/menubar/install-menubar.ts`.
