# Hero / Brand Assets

Asset contract between the landing page (`website/src/landing.ts`) and `website/public/`. All four assets are served by the Cloudflare Worker at the root path (e.g. `/wordmark.svg`).

## wordmark.svg

The "agents" wordmark — chunky monospace display weight with cut-corner pixel feel, lime (`#a3e635`) on transparent. Pure geometric paths; no embedded font, no external refs. Native viewBox is `640×160`; renders crisply from `160×40` up to retina hero sizes. A small lime block cursor sits after the last letter to keep the dev-tool tone. **Slot:** site header / top-left of the hero in `landing.ts`, replacing the previous text-only `<h1>`.

## favicon.svg

32×32 lime tile (`#a3e635`, 6px corner radius) with a near-black lowercase `a` glyph inset. Pure SVG shapes, scales clean to 16px. **Slot:** `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` in `landing.ts`, replacing the inline `>` data-URI favicon.

## benchmark.svg

`520×400` animated horizontal bar chart titled "PARALLEL SPEEDUP" comparing one sequential agent (47 min, dim grey) vs `agents teams × 3` (18 min, dim grey) vs `agents teams × 5` (11 min, lime winner with a `4.3× FASTER` badge that fades in). Bars animate from zero width via SMIL `<animate>` (eased, staggered, finishes well under 1.5s after paint). Self-contained: inline styles, generic mono fallback (`ui-monospace, Menlo, monospace`), `#0a0a0a` background, footer CTA `$ agents teams start my-feature --watch`. **Slot:** hero proof block in `landing.ts`, beneath the headline/subhead and above the demo video.

## og.png

`1200×630` social card. `#0a0a0a` background with subtle `#161616` grid, the lime "agents" wordmark (same geometry as `wordmark.svg`, scaled 1.55×) anchored top-left, tagline "One CLI for every coding agent." in light grey, sub-tagline listing the supported agents in mid-grey, lime install hint `> npm i -g @phnx-labs/agents-cli` bottom-left, and faint `agents-cli.sh` bottom-right. Replaces the prior `og.png`. **Slot:** `<meta property="og:image" content="https://agents-cli.sh/og.png">` and the Twitter card equivalent in `landing.ts`.
