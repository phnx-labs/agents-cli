### Breaking

- **Fleet routing: `--device` / `-D` only.** The `-H`/`--host` routing flag is
  removed from every command that used it for remote dispatch. Use
  `--device <name>` (or `-D`). Scripts using `--host` for fleet routing must
  switch. Legacy `--host` is still *stripped* from forwarded remote argv for
  mixed-version fleets, but is no longer registered or documented as a user
  flag. Unchanged: `agents hosts` noun, Docker `-H`/`--host`, webhook bind
  host, harness model `--host`.
