- **One resolver for `--host` / `--device` — every subcommand now dials the same box
  (RUSH-1967).** A host token used to resolve through two disagreeing code paths:
  `run --host` (and the generic passthrough, teams placement, doctor, funnel, remote
  secrets) let a `~/.ssh/config` stanza win and dialed its bare name, while
  `sessions --host`, session bundles, and `agents ssh` dialed the device Tailscale
  `user@dnsName`. The same name could reach two different machines, and because the two
  emitted different target strings they never shared a multiplexed SSH connection.
  Resolution is now a single merged lookup (`matchHost`): the live devices registry
  supplies address/OS/presence, the agents.yaml overlay supplies capability tags, and
  ssh_config supplies hosts Tailscale has never seen — merged per-field, not one
  shadowing another. Fallout fixed with it: an enrolled device address always comes from
  the live registry (so `agents devices sync` takes effect without re-enrolling, no more
  frozen route), an enrolled device keeps its presence and `dispatchable` flags, a
  password-auth device cannot be made dispatchable by shadowing it with an inline entry,
  and a host present only in `~/.ssh/config` is now visible to the `sessions --host`
  fan-out.
