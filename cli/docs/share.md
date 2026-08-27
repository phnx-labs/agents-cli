# Share — identity, namespace, and visibility

`agents artifacts share` publishes an HTML artifact (a plan, a viz, a report) to a
world-reachable link. This document is the model behind that link: **who you are
when you publish, what namespace the link lands in, and who can then read it.** For
command syntax use `agents artifacts share --help` or the
[command index](command-index.md); for onboarding use the product README.

There are two backends — a **managed** endpoint you get for free by signing in, and
a **BYO** Cloudflare R2 + Worker you provision yourself. The publication boundary
(bearer-gated writes, public reads) is described in
[observability.md](observability.md); this document covers the identity and
visibility model that sits on top of it.

## One identity: Phoenix ID

There is a **single** account behind the managed endpoint: a **Phoenix ID**. It is
the only identity agents-cli authenticates against — there is no separate "GetRush"
account and no Supabase user. `PhoenixSession` and the API base are the whole
surface (`src/lib/identity/client.ts:31` `PHOENIX_ID_BASE`, `:39`
`interface PhoenixSession`).

Sign-in is **Google-only**, over the RFC 8628 device-code flow: `agents auth login`
opens a Phoenix-branded page and the CLI never sees a password
(`src/commands/auth.ts:131` — "Sign-in is Google-only and opens a Phoenix-branded
page; the CLI never sees a password"). On approval the CLI writes the session —
`{ access_token, email, userId }` — to disk (`src/commands/auth.ts:53`
`writeSession(...)`). Every managed share request carries that session's bearer.

A signed-in user publishes to `share.agents-cli.sh/<handle>/<slug>` with the
Phoenix session and **no Cloudflare account, bucket, or write token**. Without a
session, the BYO Cloudflare path applies instead (`agents artifacts setup` /
`agents artifacts share join`), gated by a static `WRITE_TOKEN`.

## Namespace = the email local-part

The URL namespace (the `<handle>` segment) is the **local-part of the signed-in
email** — everything before the `@`, with any `+tag` dropped:

- `muqsitnawaz@gmail.com` → `muqsitnawaz`
- `muqsitnawaz+dev@gmail.com` → `muqsitnawaz`

`handleFromEmail` derives it (`src/lib/share/backend.ts:81`), and it must match the
Worker's own `handleFromEmail` so the CLI and the endpoint agree on the same
namespace. When the email is missing it falls back to a sanitized `userId`
(`backend.ts:90`). On the BYO path the namespace is instead the resolved GitHub
username (gh / `git config` / `--for-user`).

## Visibility levels

A publish stamps exactly one of four visibility levels on the stored object
(`src/lib/share/publish.ts:115` `type ShareVisibility = 'public' | 'unlisted' | 'me'
| 'org'`; the ordered set is `SHARE_VISIBILITY_LEVELS` at `:119`). `--visibility
<level>` selects it; `resolveShareVisibility` (`publish.ts:141`) resolves the flag
plus the aliases below.

| Level | Who can read | In the gallery? | Robots | Requires |
|---|---|---|---|---|
| `public` (default) | anyone with the link | **yes** — listed, gets an OG preview card | indexable | — |
| `unlisted` | anyone with the link (capability URL) | no | `X-Robots-Tag: noindex` | — |
| `me` | only the signed-in owner | no | `noindex`, `private, no-store` | Phoenix session |
| `org` | anyone at the sharer's email **domain** | no | `noindex`, `private, no-store` | Phoenix session + a workspace domain |

- **`unlisted` is a capability URL, not a secret.** GET still returns 200; it is
  only hidden from the gallery/listing and marked `noindex`
  (`worker-template.ts:356`). `--private` and `--unlisted` are hidden aliases of
  `--visibility unlisted` (`src/commands/share.ts:794`–`795`;
  `resolveShareVisibility` maps `unlisted:true` → `'unlisted'`, `publish.ts:142`).
- **`me` and `org` are identity-gated reads**, enforced at the Worker. An
  unauthenticated request for either 302-redirects to the Phoenix login
  (`gateRestrictedGet` → `bounceToLogin`, `worker-template.ts:875`, `:901`). A
  wrong viewer gets a `404`, so a restricted page never even leaks that it exists.
- `me` reads require the viewer's `userId` to equal the object's stamped `owner`
  (`viewerMayRead`, `worker-template.ts:888`). `org` reads require the viewer's
  email **domain** to equal the `org_domain` stamped at publish time
  (`worker-template.ts:893`; stamped from `emailDomain(auth.email)` at `:162` /
  `:252`).
- `me`/`org` are Phoenix-only. A BYO `WRITE_TOKEN` can publish `public`/`unlisted`
  only — the Worker rejects `me`/`org` from a non-Phoenix caller with a `400`
  (`worker-template.ts:94`–`97`), and the CLI surfaces a crisp `agents auth login`
  hint before the round trip (`share.ts:187`).

### `org` rejects public-inbox domains — the sharp edge

`org` means "anyone at **my** email domain", and the domain is derived from the
**sharer's own email**, never from any configured value. That only makes sense for a
real workspace domain, so the Worker **refuses `org` on a public-inbox domain**:

```
PUBLIC_INBOX_DOMAINS = ['gmail.com', 'googlemail.com', 'outlook.com',
                        'hotmail.com', 'live.com', 'icloud.com', 'me.com']
```

(`src/lib/share/worker-template.ts:610`). Publishing `org` from one of these returns
`400 "org visibility cannot use a public email domain"` (`worker-template.ts:102`,
and the same check on the in-place edit path at `:246`). So an `org` share is
possible **only when you are signed in with a workspace-domain Google account**
(e.g. `you@yourcompany.com`) — never with a personal `gmail.com` / `icloud.com`
address. A page that reads "Anyone at yourcompany.com" derives `yourcompany.com`
from the signer's email, not from a setting.

An empty/unverifiable domain is likewise refused (`400 "org visibility requires a
verified email domain"`, `worker-template.ts:101`).

Every HTML page also carries an always-on **attribution bar** injected at serve
time that shows the visibility as a visual cue; `?raw` does not strip it
(`worker-template.ts:366`).

## Listing hidden pages — `share list --scope` / `--all`

By default `agents artifacts share list` mirrors the **public gallery** — it lists
public pages only (`--scope public`). To see your hidden pages, name a hidden scope:

```bash
agents artifacts share list                 # public only (default)
agents artifacts share list --all           # every page, incl. unlisted/me/org (alias for --scope all)
agents artifacts share list --scope me      # just your owner-only pages
agents artifacts share list --scope unlisted # just your capability-URL pages
agents artifacts share list --scope org     # just your org pages
```

`--scope <level>` takes `public` (default), `unlisted`, `me`, `org`, or `all`;
`--all` is the convenience alias for `--scope all` (`src/commands/share.ts:1081`–
`1089`). The filter is named `--scope` (not `--visibility`) because the parent
`share <file>` command already owns `--visibility` and Commander resolves an
option's long name against the whole ancestor chain (`share.ts:1077`–`1079`).

Any hidden scope sends the **owner's bearer** and a `scope=mine` hint to the
Worker's JSON listing route (`runShareList`, `src/commands/share.ts:349`–`362`); the
Worker returns hidden pages **only after verifying the bearer owns the namespace**
(`resolveListingScope`, `worker-template.ts:551`). Each human row shows the page's
visibility so public vs hidden is obvious at a glance
(`formatShareList`, `share.ts:459`–`460`). A BYO Worker that predates the listing
route fails loud and points at `agents artifacts share update` rather than returning
a wrong-or-empty result (`OUTDATED_TEMPLATE_HINT`, `share.ts:225`).

## Changing visibility in place — `share visibility <target> <level>`

`agents artifacts share visibility <target> <level>` re-scopes an
**already-published** page without re-publishing it:

```bash
agents artifacts share visibility https://share.agents-cli.sh/octocat/q3-plan me
agents artifacts share visibility octocat/q3-plan public
agents artifacts share visibility q3-plan org      # rejected on a public-inbox domain
agents artifacts share visibility q3-plan me --visibility-json
```

`<target>` accepts the same three forms as `unshare` — a full URL, `<user>/<slug>`,
or a bare slug in your namespace; `<level>` is one of `public | unlisted | me | org`
(`src/commands/share.ts:938`–`942`). It **re-stamps only the visibility** on the
stored object via the same `PATCH` metadata-edit route as `share edit` — the slug
(and so the URL) is preserved, and the body, provenance, label, and `--meta` are
untouched, so **like `share edit` it creates no revision** (`runShareEdit`,
`share.ts:160`, `:196`). Visibility is a first-class edit field alongside `label`,
never a `--meta` entry (`visibility` is reserved).

The result flag is `--visibility-json` (not `--json`), the same ancestor-collision
rename as `--scope`/`--for-user` above (`share.ts:944`). The same gates apply as at
publish time: `me`/`org` require a Phoenix session and fail loud with an
`agents auth login` hint when signed out (`share.ts:187`), and `org` is refused on a
public-inbox domain (`worker-template.ts:246`). A BYO endpoint whose deployed Worker
predates the visibility edit **fails loud** — it 200s without echoing `visibility`
back, which the CLI detects and turns into an `agents artifacts share update` hint
rather than a silent no-op success (`share.ts:211`–`217`).

## Related

- [observability.md](observability.md) — the publication boundary (bearer-gated
  writes, public reads) and the traces surface.
- [secrets.md](secrets.md) — the BYO `cloudflare.com` / `WRITE_TOKEN` bundles.
