# Share

Publish an HTML artifact (a plan, a viz, a report) to a public link on **your own**
Cloudflare R2, behind a tiny Worker — for effectively **$0** (R2 has zero egress and a
10 GB free tier). The loop `agents share` closes: an agent makes work, publishes it,
and you open the link to see if it worked.

## Overview

```bash
agents share setup                              # once: provision on your Cloudflare
agents share plan.html --slug fleet --expire 30d # → https://<base>/fleet
agents share status                             # show the configured endpoint
```

`setup` reads a Cloudflare API token from your `cloudflare.com` secrets bundle (or pass
`--token`), creates an R2 bucket, uploads the Worker, and enables the free
`*.workers.dev` subdomain. If the token owns a zone, `--domain share.example.com` maps a
custom domain. Then `agents share <file>` does an authed `PUT` and prints the link.

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
  Cloudflare. `agents share join <baseUrl>` uses an existing endpoint without provisioning.
- **Expiry.** `--expire 30d|12h|2026-08-01` writes `expires-at` into the object's metadata;
  the Worker `410`s and lazily deletes past that instant.

## Where things live

```
agents.yaml            share:                         # baseUrl / accountId / worker / bucket / domain
  (Meta.share)                                        # syncs fleet-wide via `agents repo push/pull`
secrets bundle `share` SHARE_WRITE_TOKEN              # the raw write token — keychain-backed, never in config
```

Config is safe to sync (no secret); the write token lives only in the `share` bundle.
Push it to a peer with `agents secrets export share --host <box>`.

## Command reference

| Command | What it does |
|---|---|
| `agents share <file> [--slug s] [--expire spec]` | Publish `<file>`; print `https://<base>/<slug>`. Idempotent (re-publish = update). |
| `agents share setup [--token t] [--account id] [--bundle b] [--worker w] [--bucket b] [--domain h]` | Provision an R2 bucket + Worker on your Cloudflare and save the config. |
| `agents share join <baseUrl>` | Use an existing endpoint (base URL + write token), no provisioning. |
| `agents share status` | Show the configured endpoint. |

## Security

Reads are public by design (share links). Writes require the bearer `WRITE_TOKEN` (held by
the Worker as an encrypted CF secret; the client sends it from the `share` bundle). The
Worker's constant-time-ish compare avoids leaking the token by timing. The token is a
32-byte random hex; rotate by re-running `setup` (mints a new one) — old links keep
serving until they expire.

Source: `src/commands/share.ts`, `src/lib/share/{worker-template,provision,publish,config}.ts`,
`Meta.share` in `src/lib/types.ts`.
