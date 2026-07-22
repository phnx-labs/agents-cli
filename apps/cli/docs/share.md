# Share

Publish an HTML artifact (a plan, a viz, a report, a game) to a public link on **your own**
Cloudflare R2, behind a tiny Worker — for effectively **$0** (R2 has zero egress and a
10 GB free tier). The loop `agents share` closes: an agent makes work, publishes it,
and you open the link to see if it worked.

## Overview

```bash
agents share setup --analytics-token <cf-token>   # once: provision on your Cloudflare
agents share plan.html --slug fleet --expire 30d  # → https://<base>/<user>/fleet
agents share plan.html --json                     # machine-readable URL for hooks
agents share status                               # show endpoint, namespace, analytics
agents share analytics                            # link to the Web Analytics dashboard
```

`setup` reads a Cloudflare API token from your `cloudflare` secrets bundle (or pass
`--token`), creates an R2 bucket, installs the share lifecycle rule, uploads the Worker, sets
the `WRITE_TOKEN` Worker secret, and enables the free
`*.workers.dev` subdomain. It maps `share.agents-cli.sh` when the token owns the
`agents-cli.sh` zone; otherwise it keeps the `*.workers.dev` endpoint. Pass
`--domain share.example.com` to use a different visible zone. Then `agents share <file>`
does an authed `PUT` and prints the link.

## Architecture

```
agent makes plan.html
        │  agents share plan.html         (PUT /<user>/<slug>, Authorization: Bearer <token>)
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
  Cloudflare. `agents share join` uses synced `share:` config plus an injected
  `SHARE_WRITE_TOKEN`, and `agents share join <baseUrl>` still joins an explicit
  endpoint without provisioning.
- **Expiry.** `--expire 30d|12h|2026-08-01` writes `expires-at` into the object's metadata;
  the Worker `410`s and lazily deletes past that instant. `setup` also installs an R2
  lifecycle rule so old share objects are removed automatically even if nobody opens
  the expired link again.
- **Usage analytics.** `setup --analytics-token <cf-token>` enables Cloudflare Web Analytics:
  a cookieless, privacy-first beacon is injected into every published HTML page, so you get
  per-path pageviews without GA4-style tracking. Opt out per publish with `--no-analytics`.
  Use `agents share analytics` for the dashboard link; per-path breakdowns are available in
  the Cloudflare dashboard under `/<github-username>/`.
- **Preview cards (OG images).** Publishing an HTML page screenshots its own hero at
  1200×630 and attaches it as `og:image` + `twitter:card`, so the link unfurls into a
  rich card in Slack, iMessage, Twitter/X, and Discord. Capture is client-side (headless
  Chromium via the CLI's browser detector, with a managed-Chromium fallback), so there's
  no central render service and no extra cost. No headless browser available → the cover
  is skipped and the plain link still publishes. Opt out with `--no-cover`.
- **Plan-render automation.** Hooks that render plans can run
  `agents share <plan.html> --json` after writing the HTML and read the returned
  `{ "url", "coverUrl", "expiresAt" }` object. The human output still prints the URL on
  the first line.
- **Slugs.** With no `--slug`, the default is `<project>-<feature>-<hash>` (e.g.
  `agents-cli-fleet-cockpit-9f3c1a8b7d2e4056`): the repo name scopes the link and a
  random 64-bit tail (16 hex chars) keeps the direct URL unguessable and collision-free.
  Note that the tail is **not** a privacy control for the namespace gallery — every
  non-expired share under your namespace, random-tail slugs included, is listed on your
  public `/<github-username>` gallery (your GitHub username is public by definition), so
  treat anything you `agents share` as publicly discoverable. Pass `--slug` for a stable,
  exact name under your GitHub-username namespace.

## Where things live

```
agents.yaml            share:                         # baseUrl / accountId / worker / bucket / domain / analyticsToken
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
| `agents share <file> [--slug s] [--github-user u] [--expire spec] [--no-cover] [--no-analytics] [--json]` | Publish `<file>` under your GitHub-username namespace; print the link, or emit `{ url, coverUrl, expiresAt }` for plan-render hooks with `--json`. HTML pages get an auto OG cover unless `--no-cover` and a CF Web Analytics beacon unless `--no-analytics`. |
| `agents share setup [--token t] [--account id] [--bundle b] [--worker w] [--bucket b] [--domain h] [--analytics-token token]` | Provision an R2 bucket + Worker on your Cloudflare, map `share.agents-cli.sh` when visible (or `--domain h`), optionally configure a CF Web Analytics token, and save the config. |
| `agents share join [baseUrl] [--token t]` | Use an existing endpoint, no provisioning. With no URL, consumes synced `share:` config plus `SHARE_WRITE_TOKEN` / the local `share` bundle. |
| `agents share status` | Show the configured endpoint, namespace, and analytics state. |
| `agents share analytics` | Show the Web Analytics status and dashboard link. |

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
- **Use `--expire` for sensitive content.** There is no default expiry. `--expire 30d`
  (or `12h`, or an absolute `2026-08-01`) bounds the window in which a leaked link is
  live; the Worker `410`s and lazily deletes past that instant. Shorter is safer.
- **A true auth-gated read is a future option, not shipped.** For content that must be
  genuinely private rather than merely unlisted, the intended path is an opt-in,
  auth-gated read — a bearer token or a signed, short-lived link required to _view_ (not
  just to publish). That is deliberately not implemented today; until it lands, only
  publish here what you're comfortable being world-readable-if-the-URL-leaks.

Writes require the bearer `WRITE_TOKEN` (held by the Worker as an encrypted CF secret; the
client sends it from the `share` bundle). The Worker's constant-time-ish compare avoids
leaking the token by timing. The token is a 32-byte random hex; rotate by re-running
`setup` (mints a new one) — old links keep serving until they expire.

Source: `src/commands/share.ts`, `src/lib/share/{worker-template,provision,publish,config,analytics}.ts`,
`Meta.share` in `src/lib/types.ts`.
