# Share

Publish an HTML artifact (a plan, a viz, a report) to a public link on **your own**
Cloudflare R2, behind a tiny Worker — for effectively **$0** (R2 has zero egress and a
10 GB free tier). The loop `agents share` closes: an agent makes work, publishes it,
and you open the link to see if it worked.

## Overview

```bash
agents share setup                              # once: provision on your Cloudflare
agents share plan.html --slug fleet --expire 30d # → https://<base>/fleet
agents share plan.html --json                  # machine-readable URL for hooks
agents share status                             # show the configured endpoint
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
        │  agents share plan.html         (PUT /<slug>, Authorization: Bearer <token>)
        ▼
   the Worker  ──(R2 binding).put()──►  R2 bucket (your account)
        ▲
        │  GET /<slug>   (public, no auth)
   any browser  ◄── streams HTML from R2, 410 + lazy-delete once expired
```

- **The Worker is the ingress.** Writes are bearer-gated *through* it — its R2 binding
  does the `put`, so the client needs **no S3 keys**. Reads are public: the link outlives
  the agent, because the page is stored in R2, not streamed.
- **Fleet / central mode.** Provision one endpoint (the owner); every fleet / cloud /
  ephemeral agent then publishes through it with a shared write token — no per-agent
  Cloudflare. `agents share join` uses synced `share:` config plus an injected
  `SHARE_WRITE_TOKEN`, and `agents share join <baseUrl>` still joins an explicit
  endpoint without provisioning.
- **Expiry.** `--expire 30d|12h|2026-08-01` writes `expires-at` into the object's metadata;
  the Worker `410`s and lazily deletes past that instant. `setup` also installs an R2
  lifecycle rule so old share objects are removed automatically even if nobody opens
  the expired link again.
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
  `agents-cli-fleet-cockpit-3a6687`): the repo name scopes the link and a short random
  tail keeps it unguessable and collision-free. Pass `--slug` for a stable, exact name.

## Where things live

```
agents.yaml            share:                         # baseUrl / accountId / worker / bucket / domain
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
| `agents share <file> [--slug s] [--expire spec] [--no-cover] [--json]` | Publish `<file>`; print the link, or emit `{ url, coverUrl, expiresAt }` for plan-render hooks with `--json`. HTML pages get an auto OG cover unless `--no-cover`. Default slug `<project>-<feature>-<hash>`. |
| `agents share setup [--token t] [--account id] [--bundle b] [--worker w] [--bucket b] [--domain h]` | Provision an R2 bucket + Worker on your Cloudflare, map `share.agents-cli.sh` when visible (or `--domain h`), and save the config. |
| `agents share join [baseUrl] [--token t]` | Use an existing endpoint, no provisioning. With no URL, consumes synced `share:` config plus `SHARE_WRITE_TOKEN` / the local `share` bundle. |
| `agents share status` | Show the configured endpoint. |

## Security

Reads are public by design (share links). Writes require the bearer `WRITE_TOKEN` (held by
the Worker as an encrypted CF secret; the client sends it from the `share` bundle). The
Worker's constant-time-ish compare avoids leaking the token by timing. The token is a
32-byte random hex; rotate by re-running `setup` (mints a new one) — old links keep
serving until they expire.

Source: `src/commands/share.ts`, `src/lib/share/{worker-template,provision,publish,config}.ts`,
`Meta.share` in `src/lib/types.ts`.
