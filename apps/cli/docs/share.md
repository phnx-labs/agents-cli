# Share

Publish an HTML artifact (a plan, a viz, a report, a game) to a public link on **your own**
Cloudflare R2, behind a tiny Worker — for effectively **$0** (R2 has zero egress and a
10 GB free tier). The loop `agents artifacts share` closes: an agent makes work, publishes it,
and you open the link to see if it worked.

> **Moved in RUSH-2580.** The commands used to be top-level `agents share …`, with
> provisioning split across `agents share setup` and `agents setup share`. They are now
> `agents artifacts share …` and one `agents artifacts setup`. `agents unshare` is
> unchanged.

## Overview

```bash
agents artifacts setup --analytics-token <cf-token>            # once: provision on your Cloudflare
agents artifacts share plan.html                              # → public link, default 30d expiry
agents artifacts share plan.html --unlisted --expire 12h      # hidden from gallery; still world-readable by URL
agents artifacts share plan.html --slug fleet --expire never  # permanent public slug
agents artifacts share plan.html --json                       # machine-readable URL for hooks
agents artifacts share status                                 # show endpoint, namespace, analytics, template
agents artifacts share analytics                              # link to the Web Analytics dashboard
agents artifacts share update                                 # re-deploy the Worker to the latest template
agents unshare fleet                                          # take the link (+ its OG cover) down
```

`setup` reads a Cloudflare API token from your `cloudflare` secrets bundle (or pass
`--token`), creates an R2 bucket, installs the share lifecycle rule, uploads the Worker, sets
the `WRITE_TOKEN` Worker secret, and enables the free
`*.workers.dev` subdomain. It maps `share.agents-cli.sh` when the token owns the
`agents-cli.sh` zone; otherwise it keeps the `*.workers.dev` endpoint. Pass
`--domain share.example.com` to use a different visible zone. Then `agents artifacts share <file>`
does an authed `PUT` and prints the link. Re-running `agents artifacts setup` interactively
against an already-configured endpoint offers to update the deployed Worker in place
instead of only "keep" or "reconfigure from scratch" — see
[Updating the deployed Worker](#updating-the-deployed-worker).

## Architecture

```
agent makes plan.html
        │  agents artifacts share plan.html         (PUT /<user>/<slug>, Authorization: Bearer <token>)
        ▼
   the Worker  ──(R2 binding).put()──►  R2 bucket (your account)
        ▲
        │  GET /<user>/<slug>   (public, no auth)
   any browser  ◄── streams HTML from R2, 410 + lazy-delete once expired
        │
        │  GET /<user>          (public gallery of that user's shares)
```

- **The Worker is the ingress.** Writes are bearer-gated *through* it — its R2 binding
  does the `put`, so the client needs **no S3 keys**. Reads are public: the link outlives
  the agent, because the page is stored in R2, not streamed.
- **Per-user namespaces.** Shares are scoped to the publisher's GitHub username:
  `https://<base>/<github-username>/<slug>`. The username is resolved from `gh auth login`,
  `git config --global github.user`, or the `AGENTS_SHARE_GITHUB_USER` env var, and can be
  overridden per-publish with `--github-user`. Visiting `/<username>` renders a public gallery
  of that user's shares. Old flat slugs (published before namespaces) still resolve for
  backward compatibility.
- **Fleet / central mode.** Provision one endpoint (the owner); every fleet / cloud /
  ephemeral agent then publishes through it with a shared write token — no per-agent
  Cloudflare. `agents artifacts share join` uses synced `share:` config plus an injected
  `SHARE_WRITE_TOKEN`, and `agents artifacts share join <baseUrl>` still joins an explicit
  endpoint without provisioning.
- **Expiry.** Publishes default to **30 days** (`--expire 30d`) so an accidental share
  decays instead of living forever (RUSH-2443). Pass `--expire 12h`, an absolute date
  (`2026-08-01`), or `--expire never` for a permanent link. Expiry writes `expires-at`
  into the object's metadata; the Worker `410`s and lazily deletes past that instant.
  `setup` also installs an R2 lifecycle rule so old share objects are removed
  automatically even if nobody opens the expired link again.
- **Unlisted / private.** `--unlisted` (alias `--private`) stores `visibility=unlisted`
  on the object. The public `/<user>` gallery and `agents artifacts share list` omit it; the
  direct URL is still world-readable (capability URL — unlisted, not secret). Use with
  a short `--expire` when bounding blast radius after an accidental sensitive publish.
- **Pre-publish scan.** Before upload, the CLI refuses files that contain email addresses
  or credential-shaped strings (`ghp_…`, `sk-…`, `AKIA…`, `Bearer …`, …) — the exact
  failure mode behind RUSH-2428. Pass `--force` to publish anyway.
- **Usage analytics.** `setup --analytics-token <cf-token>` enables Cloudflare Web Analytics:
  a cookieless, privacy-first beacon is injected into every published HTML page, so you get
  per-path pageviews without GA4-style tracking. Opt out per publish with `--no-analytics`.
  Use `agents artifacts share analytics` for the dashboard link; per-path breakdowns are available in
  the Cloudflare dashboard under `/<github-username>/`.
- **Preview cards (OG images).** Publishing an HTML page screenshots its own hero at
  1200×630 and attaches it as `og:image` + `twitter:card`, so the link unfurls into a
  rich card in Slack, iMessage, Twitter/X, and Discord. Capture is client-side (headless
  Chromium via the CLI's browser detector, with a managed-Chromium fallback), so there's
  no central render service and no extra cost. No headless browser available → the cover
  is skipped and the plain link still publishes. Opt out with `--no-cover`.
- **Static media, not just HTML.** `agents artifacts share <file>` publishes any static asset —
  a PNG/JPEG/GIF/WebP/AVIF screenshot, an MP4/MOV/WebM screen recording, a PDF — and
  serves it with the matching `content-type` (not `application/octet-stream`). That is
  what lets an agent embed visual PR evidence: GitHub's image proxy (camo) only renders
  an inline `![](url)` when the asset is served as a real image/video type, so a shared
  screenshot or recording drops straight into a PR body. Media publishes carry no OG
  cover (that is an HTML-only step).
- **Plan-render automation.** Hooks that render plans can run
  `agents artifacts share <plan.html> --json` after writing the HTML and read the returned
  `{ "url", "coverUrl", "expiresAt" }` object. The human output still prints the URL on
  the first line.
- **Slugs.** With no `--slug`, the default is `<project>-<feature>-<hash>` (e.g.
  `agents-cli-fleet-cockpit-9f3c1a8b7d2e4056`): the repo name scopes the link and a
  random 64-bit tail (16 hex chars) keeps the direct URL unguessable and collision-free.
  Note that the tail is **not** a privacy control for the namespace gallery — every
  non-expired share under your namespace, random-tail slugs included, is listed on your
  public `/<github-username>` gallery (your GitHub username is public by definition), so
  treat anything you `agents artifacts share` as publicly discoverable. Pass `--slug` for a stable,
  exact name under your GitHub-username namespace.

## Provenance, labels, and metadata

Every publish stores who/what/where/when it came from, plus a human title, so
`agents artifacts share list` and the gallery are a genuinely useful record of everything
you've shared, not just a bag of slugs:

- **Provenance is captured automatically** from the exec env, git, and the local
  clock — `agent` (`AGENTS_AGENT_NAME`), `session` (`AGENTS_SESSION_ID` /
  `AGENT_SESSION_ID`), `host` (`os.hostname()`), `repo` (the current git repo
  name), and `date`. Never invented: a field is stored only when the
  environment genuinely carries it — a human publishing by hand outside a git
  repo gets `agent`/`session`/`repo` all absent, never a guess.
- **`--label <text>` (alias `--title`)** sets the human display title shown
  instead of the slug in the gallery and `share list`. Omit it and one is
  derived — the HTML `<title>`, else a Markdown frontmatter `title:`, else the
  filename — and the publish result names it `(derived — pass --label to set
  one)`. This is a **nudge, never a block**: a headless publish never hangs
  waiting on a prompt for a title.
- **`--meta key=value` (repeatable)** attaches structured metadata — keys are
  lowercase `[a-z0-9-]`, up to 64 characters. Recommended (not enforced) keys:
  `kind` (`plan`/`report`/`visual`/`screenshot`/`recording`/`deck`/`doc`),
  `project`, `ticket`, `status` (`draft`/`final`). `agent`, `session`, `host`,
  `repo`, `date`, `label`, and `label-source` are **reserved** — the CLI sets
  them automatically and refuses a `--meta` that collides with one, and the
  Worker independently strips the same reserved keys from stored metadata even
  if a raw request somehow smuggled one through. The combined metadata payload
  (provenance + label + `--meta`) is capped around 2KB, the same ceiling S3's
  `x-amz-meta` convention uses, so a share stays portable to an S3-compatible
  mirror even though R2 itself publishes no hard limit of its own. Every
  `--meta` entry is readable again via `agents artifacts share list --json`
  and `agents artifacts share revisions --revisions-json` (each item's `meta`
  field) and shown as `key=value` pairs in the human tables too — it isn't
  write-only.
- **`--label` and every `--meta` value are scanned for emails/credentials**,
  same as the file body — they land in the same public `customMetadata` (the
  gallery, `share list --json`, `share revisions`), so a credential in either
  is exactly as exposed as one in the page. `--force` bypasses this the same
  way it bypasses the body scan.
- **Storage:** R2 has neither mutable object tags (`PutObjectTagging` and
  friends are unimplemented) nor object versioning — this is `customMetadata`
  set at `PUT` time via `x-share-*` request headers, immutable per revision.
  Each republish is a fresh `PUT` with its own metadata; see
  [Revisions](#revisions) for how the prior version is kept.

```bash
agents artifacts share ./out/plan.html --label "Q3 fleet plan" --meta kind=plan --meta ticket=RUSH-2683
```

## Revisions

Cloudflare R2 has **no native object versioning** (`PutBucketVersioning` /
`ListObjectVersions` are unimplemented, and `GetObject` takes no `versionId`) —
so a republish of an existing slug used to silently overwrite the object.
`agents artifacts share` now keeps history at the application level: overwriting an
existing `<user>/<slug>` first copies the CURRENT object (body + metadata) to
`<user>/<slug>/rev-<timestamp>-<random>`, then writes the new content to the
canonical key. The canonical URL is always the latest version; every prior one
stays reachable at its own revision URL and honors its own recorded expiry.

```bash
agents artifacts share ./out/plan.html --slug q3-report          # v1
agents artifacts share ./out/plan.html --slug q3-report          # v2 — v1 kept as a revision
agents artifacts share revisions q3-report                       # → v1, newest-first
agents artifacts share ./out/plan.html --slug q3-report --no-revision   # overwrite with no backup
```

Default is **keep all** — R2 storage is cheap enough (~$0) that pruning old
revisions is a deliberate follow-up, not something publish does for you. Pass
`--no-revision` to skip retention for one publish. Revisions never appear on
the public gallery or in `agents artifacts share list` beyond a `revisionCount` on
their canonical entry — they are history, not additional public pages.

> **Known limitation.** The copy-then-overwrite isn't atomic (no conditional put) — two
> genuinely concurrent publishes to the *same* slug (e.g. two teammates writing the same
> ticket-derived slug at once) can race on the canonical key, and the losing writer's
> content is never retained anywhere (not canonical, not a revision). No worse than
> plain last-write-wins would have been pre-revisions, but it silently breaks the
> "default keep-all" guarantee above for that narrow case. Tracked as RUSH-2701.
`agents artifacts share revisions <target>` accepts the same three target forms as
`agents unshare` (full URL, `<user>/<slug>`, or a bare slug resolved against
your own namespace) and reads the Worker's `?revisions=json` route:

```json
{ "key": "octocat/q3-report", "count": 1,
  "revisions": [ { "key": "octocat/q3-report/rev-1755000000000-a1b2c3", "url": "https://share.agents-cli.sh/octocat/q3-report/rev-1755000000000-a1b2c3",
                   "size": 20481, "contentType": "text/html; charset=utf-8", "uploadedAt": "2026-08-08T12:00:00.000Z",
                   "expiresAt": null, "label": "Q3 fleet plan", "agent": "claude", "session": "sess-1", "host": "zion", "repo": "agents-cli" } ] }
```

## Updating the deployed Worker

`worker-template.ts` is the source of truth for the Worker's behavior, but `setup` only
ever writes it out during first provisioning — an endpoint provisioned last month is
stuck on last month's template until you push the current one out:

```bash
agents artifacts share status   # → template current | outdated | unknown
agents artifacts share update   # re-deploy the current template to your EXISTING endpoint
```

`update` reuses the account, Worker name, and bucket already in your config — it never
creates a bucket, touches routes/custom domains/`*.workers.dev`, and never regenerates
`WRITE_TOKEN`. It's idempotent: re-running it when the deployed template already matches
is a no-op (`--force` to redeploy anyway). A config from before this existed has no
recorded hash and reads as `unknown` in `status` — running `update` once establishes it.

Cloudflare's script-upload API replaces a Worker's bindings and secrets wholesale on
every upload; `update` re-applies the existing `WRITE_TOKEN` via the Secrets API
immediately after the script upload so it survives (see `updateWorker` in
`lib/share/provision.ts` for the full reasoning and links to Cloudflare's docs).

If the script upload succeeds but the secret re-apply then fails (network blip, expired
API token, rate limit), the live Worker has **no write token** — every publish and
delete 401s until the failure is healed. The error names that state and tells you to
re-run `agents artifacts share update`. Config is only rewritten after *both* steps succeed, so
a plain re-run does not short-circuit on a matching hash and will re-deploy + re-set
the secret.

## Where things live

```
agents.yaml            share:                         # baseUrl / accountId / worker / bucket / domain / analyticsToken / templateHash
  (Meta.share)                                        # syncs fleet-wide via `agents repo push/pull`
secrets bundle `share` WRITE_TOKEN                    # the raw write token — keychain-backed, never in config
```

Config is safe to sync (no secret); the write token lives only in the `share` bundle
or a runtime `SHARE_WRITE_TOKEN` env var injected into an ephemeral agent. Push the
bundle to a peer with `agents secrets export share --host <box>`; local agent,
teammate, and supported cloud launches inject the token automatically when the
synced config exists and the token is already available.

## Command reference

| Command | What it does |
|---|---|
| `agents artifacts share <file> [--slug s] [--github-user u] [--expire spec] [--unlisted\|--private] [--force] [--no-cover] [--no-analytics] [--label text] [--meta k=v ...] [--no-revision] [--json]` | Publish `<file>` under your GitHub-username namespace (default expiry **30d**); print the link, or emit `{ url, coverUrl, expiresAt, unlisted?, label, labelSource }` for plan-render hooks with `--json`. `--unlisted`/`--private` hides from the gallery; `--force` bypasses the email/credential scan. HTML pages get an auto OG cover unless `--no-cover` and a CF Web Analytics beacon unless `--no-analytics`. `--label`/`--title` sets a human title (else derived); `--meta` attaches structured metadata; republishing an existing slug keeps the prior version unless `--no-revision` (see [Provenance, labels, and metadata](#provenance-labels-and-metadata) and [Revisions](#revisions)). |
| `agents artifacts share list [--github-user u] [--agent name] [--session id] [--label-contains substr] [--json]` | List the ACTIVE pages in your namespace, newest first — human table, or the raw listing with `--json` (see [Listing your shares](#listing-your-shares) below). `--agent`/`--session`/`--label-contains` narrow the fetched list client-side. |
| `agents artifacts share revisions <target> [--for-user u] [--revisions-json]` | Show the retained prior versions of one published slug, newest first (see [Revisions](#revisions)). Flags named `--for-user`/`--revisions-json`, not `--github-user`/`--json` — see the note below. |
| `agents artifacts share delete <targets...>` / `agents unshare <targets...>` | Take a published page down (see [Deleting a share](#deleting-a-share) below). |
| `agents artifacts setup [--token t] [--account id] [--bundle b] [--worker w] [--bucket b] [--domain h] [--analytics-token token]` | Provision an R2 bucket + Worker on your Cloudflare, map `share.agents-cli.sh` when visible (or `--domain h`), optionally configure a CF Web Analytics token, and save the config. It runs the interactive wizard (provision, join, or update an existing endpoint) only when you type **no** endpoint flag on a TTY; type any of `--bundle`/`--worker`/`--bucket`/`--account`/`--token`/`--domain`/`--analytics-token`, or run non-interactively, and it provisions directly with what you named — matching what the retired `agents share setup` did. |
| `agents artifacts share join [baseUrl] [--token t]` | Use an existing endpoint, no provisioning. With no URL, consumes synced `share:` config plus `SHARE_WRITE_TOKEN` / the local `share` bundle. |
| `agents artifacts share status` | Show the configured endpoint, namespace, analytics state, and whether the deployed Worker matches the current template. |
| `agents artifacts share analytics` | Show the Web Analytics status and dashboard link. |
| `agents artifacts share update [--bundle b] [--account id] [--token t] [--force] [--json]` | Re-deploy the Worker script to your existing endpoint (same account/worker/bucket, same write token). No-op when the deployed template already matches unless `--force`. |

> **Known issue (pre-existing).** `--json` and `--github-user`, passed to `list`/`delete`/`update`,
> are silently dropped — even used alone, with no other flags. The cause: commander resolves a long
> option name against the WHOLE ancestor chain, not per-command, and `share <file>` (the parent)
> already declares both names for its own use; the child's value never reaches its action. `--help`
> shows the flag as registered, which makes this easy to miss. `list`'s own filters were named to
> avoid the collision (`--label-contains`, plus the already-unique `--agent`/`--session`, which DO
> work) — but its pre-existing `--json`/`--github-user` were left as-is, tracked as RUSH-2687. `revisions`
> is new in RUSH-2683, so it ships with non-colliding names from the start instead — `--for-user` and
> `--revisions-json` — rather than adding a fourth broken instance. The real generalized fix needs
> `enablePositionalOptions()` audited across the whole CLI (a global parsing-behavior change, not a
> share-only one) — still tracked as RUSH-2687 for `list`/`delete`/`update`.

## Listing your shares

`agents artifacts share list` answers "what have I published?" from the CLI. Before it existed,
the only way to enumerate your public pages after an accidental publish was to fetch the
gallery HTML and grep it (the RUSH-2428 incident). It reads the Worker's machine-readable
listing route (`GET /<user>?format=json`) for your namespace and prints a table, newest
first:

```bash
agents artifacts share list                          # human table for your own namespace
agents artifacts share list --agent claude            # only shares published by this harness
agents artifacts share list --label-contains "fleet"  # only shares whose title contains this text

# --json is affected by the Known issue above (silently ignored) — for scripts,
# hit the Worker's JSON route directly instead:
curl -s "https://share.agents-cli.sh/$(gh api user --jq .login)?format=json" | jq -r '.objects[].url'
```

The listing shows the **active** pages only — expired links and the sibling `<slug>.png`
OG covers are omitted, mirroring the public gallery. Each object carries its `slug`, full
`url`, `size` (bytes), `contentType`, `publishedAt`, `expiresAt` (or `null`), `label`,
`agent`, `session`, `host`, `repo` (each `null` when unset), and `revisionCount`. The
`--json` shape is stable and additive-only:

```json
{ "user": "octocat", "count": 1,
  "objects": [ { "slug": "fleet-status-9f3c", "url": "https://share.agents-cli.sh/octocat/fleet-status-9f3c",
                 "size": 20481, "contentType": "text/html; charset=utf-8",
                 "publishedAt": "2026-08-08T12:00:00.000Z", "expiresAt": null,
                 "label": "Fleet status", "agent": "claude", "session": "sess-1",
                 "host": "zion", "repo": "agents-cli", "revisionCount": 2 } ] }
```

The listing route ships with the current Worker template, so it only reaches you after the
deployed Worker carries it. An endpoint provisioned before this feature has no such route:
rather than a confusing 404 or an HTML body, `list` fails loud with
`Your deployed share Worker has no machine-readable listing route … Run agents artifacts share update`.
`agents artifacts share update` (RUSH-2449) pushes the current template out to your existing
endpoint; `agents artifacts share status` tells you whether an update is due (see
[Updating the deployed Worker](#updating-the-deployed-worker)).

## Deleting a share

`agents artifacts share delete <targets...>` (alias `agents unshare`) takes a published page down.
It accepts several targets at once, in any of the three forms `agents artifacts share <file>` can
produce or that you'd copy off a link:

```bash
agents unshare https://share.agents-cli.sh/octocat/fleet-status-9f3c   # full URL
agents unshare octocat/fleet-status-9f3c                               # <user>/<slug>
agents unshare fleet-status-9f3c                                       # bare slug — resolved
                                                                        # against YOUR namespace,
                                                                        # the same way publish does
agents unshare fleet-status-9f3c old-report --if-exists                # several at once
```

By default it also deletes the sibling `<slug>.png` OG cover — a republish over a slug
replaces the page but leaves the *old* cover screenshot public, so leaving it up looks
like a takedown from the page side while the cover keeps serving. Pass `--keep-cover`
to leave it. It also deletes any retained revisions of the target (see
[Revisions](#revisions)) — a share republished at least once leaves its prior version(s)
live at their own URL, and leaving those up would defeat the point of taking the page
down; pass `--keep-revisions` to leave them (they still expire on their own via the
bucket's lifecycle rule either way). An already-missing target is an error (say so
plainly) unless `--if-exists` is passed, matching SQL's `DROP ... IF EXISTS` — a no-op
success instead of a crash or a silent no-op either way.

The Worker's `DELETE` is idempotent (R2 delete succeeds even on a key that was never
there), so `{"ok":true}` from the Worker is never treated as proof a page came down: the
command always issues a follow-up check and only reports success once that resolves 404
for the page, the cover (unless `--keep-cover`), and every retained revision (unless
`--keep-revisions`). Fetching the revisions list is best-effort — a network blip or an
endpoint that predates revisions never blocks the primary page delete, it just means
nothing was found to purge. `--json` emits an array of per-target results for scripting.

## Security

**The security model is _unlisted, not secret_.** A share link is an
[unguessable-URL capability](https://en.wikipedia.org/wiki/Capability-based_security):
the URL _is_ the credential. There is no read-side auth — anyone who has (or guesses)
the link can read the content, and the Worker serves it to them.

- **Reads are public by design.** `GET /<slug>` is unauthenticated. Do not treat a
  share link as a private channel: if the URL leaks (a forwarded chat, a proxy log, a
  referrer header, browser history on a shared machine), the content is exposed. Anything
  that must be _actually_ private should not be published here as-is.
- **The default slug is hard to guess, not a secret.** The random tail is a 64-bit
  nonce (`randomBytes(8)`, 16 hex chars) — `~1.8e19` possibilities, infeasible to
  brute-force. (It was a 24-bit / 6-hex tail before RUSH-1821, only `~1.7e7` — small
  enough to enumerate; that's now fixed.) The `<project>-<feature>-` prefix is predictable,
  so the nonce is doing all the work — which is exactly why it needs the full 64 bits.
- **Default expiry is 30 days.** Unflagged publishes auto-expire so an accidental link
  decays. Pass `--expire 12h` (or shorter) for sensitive content, or `--expire never`
  only when the page is intentionally permanent. The Worker `410`s and lazily deletes
  past the expiry instant.
- **`--unlisted` / `--private` hides from the gallery, not from the URL.** An unlisted
  page is omitted from `/<user>` and `agents artifacts share list`, but anyone with the link can
  still read it. Prefer unlisted + short expiry over "hope nobody finds the gallery".
- **Pre-publish scan refuses emails and credential-shaped strings.** The CLI scans the
  file before upload and exits non-zero when it finds them — pass `--force` only when
  you have audited the page. This is the mechanical backstop for the RUSH-2428 incident
  (a report with account emails published world-readable by routine).
- **A page can be taken down manually with `agents unshare`.** For anything that needs
  to come down before expiry (or immediately, on an accidental publish of sensitive
  content), `agents unshare <link>` deletes the page and its OG cover and verifies both
  404 before reporting success — see [Deleting a share](#deleting-a-share).
- **A true auth-gated read is a future option, not shipped.** For content that must be
  genuinely private rather than merely unlisted, the intended path is an opt-in,
  auth-gated read — a bearer token or a signed, short-lived link required to _view_ (not
  just to publish). That is deliberately not implemented today; until it lands, only
  publish here what you're comfortable being world-readable-if-the-URL-leaks.

Writes require the bearer `WRITE_TOKEN` (held by the Worker as an encrypted CF secret; the
client sends it from the `share` bundle). The Worker's constant-time-ish compare avoids
leaking the token by timing. The token is a 32-byte random hex; rotate by re-running
`setup` (mints a new one) — old links keep serving until they expire.

Source: `src/commands/share.ts`, `src/lib/share/{worker-template,provision,publish,delete,config,analytics}.ts`,
`Meta.share` in `src/lib/types.ts`.
