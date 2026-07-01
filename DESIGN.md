---
version: alpha
name: "agents-cli"
description: "The meta harness engineering system for agents. agents-cli is a terminal-first tool with a matching web surface (the agents-cli.sh landing page and the VS Code / Cursor extension webview). One brand across two mediums: a dark terminal console with a single neon-lime accent. Sans/mono type is Geist; the CLI itself speaks in chalk-semantic ANSI color."

colors:
  # Brand — lime-400. The one accent that means "live / active / success",
  # shared verbatim by the landing page and the extension webview.
  brand: "#a3e635"
  brand-600: "#84cc16"
  brand-700: "#65a30d"
  brand-ring: "rgba(163,230,53,0.25)"

  # Web canvas (landing + webview) — near-black, high contrast.
  bg: "#0a0a0a"
  bg-panel: "#141414"
  bg-recessed: "#0f0f0f"
  text: "#E7E5E4"
  text-muted: "#A8A29E"
  text-dim: "#6E6A63"
  border: "rgba(255,255,255,0.08)"

  # Terminal (ANSI, via chalk) — semantic, not literal hex. The renderer maps
  # these to the user's terminal theme; the meaning is what's fixed, not the pixel.
  term-success: "green"
  term-error: "red"
  term-warning: "yellow"
  term-identifier: "cyan"
  term-secondary: "gray"
  term-emphasis: "bold"

typography:
  # Web surface — Geist (sans) + Geist Mono. Terminal inherits the user's font.
  heading:
    fontFamily: "Geist, -apple-system, system-ui, sans-serif"
    fontWeight: 700
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Geist, -apple-system, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  mono:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, monospace"

rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"

spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"

components:
  # Web
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "#0a0a0a"
    rounded: "{rounded.sm}"
    padding: "0 {spacing.md}"
  # Terminal atoms (semantic — see the Terminal Surface section for full grammar)
  cli-success-line:
    marker: "✓"
    color: "{colors.term-success}"
  cli-error-line:
    marker: "✗"
    color: "{colors.term-error}"
  cli-table-header:
    style: "{colors.term-emphasis}"
    case: "UPPERCASE, space-padded columns"
  cli-hint:
    color: "{colors.term-secondary}"
    indent: "2 spaces"
---

## Overview

agents-cli is a **terminal-first tool that also wears a web face**. The same brand shows up in two mediums, and the design job is to make them feel like one product:

- **The terminal** — the primary surface. Thousands of lines of `chalk`-colored output, spinners, and stamped ASCII tables. This is where the tool lives.
- **The web** — the [agents-cli.sh](https://agents-cli.sh) landing page and the VS Code / Cursor extension webview. A dark terminal console rendered in HTML: black canvas, one neon-lime accent, Geist type. (The extension's design system is documented in full at `swarmify/extension/DESIGN.md`, and its CSS header states outright that it "matches the agents-cli landing palette.")

The through-line across both is **quiet, dense, high-signal**. The tool is mostly gray — secondary text, paths, hints — so that the rare colored element (a green success, a red failure, a lime call-to-action) carries real weight. The brand personality is a *developer-first performance instrument*: the landing headline is "The meta harness engineering system for agents," and the hero stat is "4.3× FASTER." Nothing is decorative; every glyph and color is a status signal.

## Colors

There are two color systems, because there are two renderers.

### Web (landing + webview)

The brand is **lime-400** (`#a3e635`) on a near-black canvas — the exact palette the extension mirrors. One accent, used sparingly, for "live / active / primary." Hover and press deepen to `brand-600` (`#84cc16`) and `brand-700` (`#65a30d`); focus rings use `brand-ring` (`rgba(163,230,53,0.25)`). Surfaces run a short black-up ladder (`#0a0a0a` canvas → `#0f0f0f` wells → `#141414` panels); text is a warm-gray hierarchy (`#E7E5E4` → `#A8A29E` → `#6E6A63`). See `swarmify/extension/DESIGN.md` for the complete, per-token web system.

### Terminal (ANSI via chalk)

The CLI never hardcodes hex — it uses `chalk`'s semantic ANSI names, so output respects the user's own terminal theme. What's fixed is **meaning**, and the meaning is remarkably consistent across the codebase (usage counts from `src/`):

| Role | chalk color | Used for | Frequency |
|---|---|---|---|
| Secondary | `gray` / `dim` | Hints, paths, disabled state, metadata — the default voice | ~1188× |
| Error | `red` | Failures, blocked actions, `✗` | ~492× |
| Warning | `yellow` | Platform-gated features, pending, caution | ~304× |
| Success | `green` | Enabled, completed, `✓` / `●` / `+` markers | ~295× |
| Emphasis | `bold` | Table column headers (`NAME`, `BUNDLE`), section titles | ~272× |
| Identifier | `cyan` | Names of things — teams, agents, files, aliases, keys, `[user]` | ~198× |
| Value | `white` | Primary literal values | ~52× |

`magenta` and `blue` appear rarely (~24× / ~22×) as one-off accents; reach for them almost never. The dominance of gray is the point: **the terminal is calm by default, and color is the exception that means something.**

## Typography

**Web:** Geist for interface text, Geist Mono for anything machine-shaped (code, CLI examples, tokens). The mono/sans split is the hierarchy — prose is human, monospace is the machine.

**Terminal:** typography is the user's terminal font; the CLI controls only weight (`bold`), dimming (`dim`), and layout. Hierarchy is created with **column alignment** (`.padEnd()` fixed-width columns) and `bold` headers, not type size — a monospace grid is the only typographic tool a terminal has, so lean on it.

## Layout

**Terminal layout is a monospace grid.** Tables are built from space-padded columns (`'NAME'.padEnd(24)`, `.padEnd(16)`, `.padEnd(28)`) with a `bold` header row, so everything aligns without box-drawing chrome. Conventions:

- **Two-space indent** for sub-lines and detail rows under a heading.
- **`backtick`-wrapped command hints** in gray (e.g. `` `agents menubar enable` ``) so the next action is always literally spelled out.
- **Aligned key/value pairs** — label left, value right, padded to a common width.
- No heavy ASCII boxes; alignment and color do the structuring.

**Web layout** follows the shared agents web system (dense 13px base, small radii, embossed panels) — see the extension DESIGN.md.

## Shapes

**Web:** tight, mechanical corners on a `3 / 4 / 6 / 8px` radius scale (buttons `4px`, panels `6px`, cards `8px`) — hardware has crisp edges.

**Terminal:** shape is glyph vocabulary. A small, fixed set carries all state — do not invent new ones:

- `✓` success · `✗` failure
- `●` active / on · `○` inactive / off
- `→` flow or "leads to" · `←` annotation pointer (e.g. `← this machine`)
- `·` `•` bullets · `—` section separator · `-` list marker (the workhorse)

## Components

### Web
Primary button: solid lime, near-black text, `4px` radius. Panels, badges, keycaps, LED status dots — all defined in the extension design system (`swarmify/extension/DESIGN.md`); reuse it rather than reinventing web chrome here.

### Terminal
- **Status line** — glyph + colored label + gray detail: `✓ Menu bar helper enabled.` then dim follow-up.
- **Spinner** — `ora` for any async step (installs, syncs, network); resolve it to a `green ✓` or `red ✗` line, never leave it spinning.
- **Table** — `bold` UPPERCASE header row, `.padEnd()` columns, `cyan` names, `gray` metadata, status glyphs in the state column.
- **Hint** — two-space-indented gray line with a `backtick` command, appended after an action so the user always knows the next move.
- **Error** — `red` message + a `gray` "why / how to fix" follow-up line; never a bare stack trace.

## Do's and Don'ts

**Do:**
- Keep the terminal quiet — `gray` is the default; reserve `green`/`red`/`yellow`/lime for signal.
- Use the semantic role, not the raw color: think "this is an error" (`red`), "this is a name" (`cyan`), not "make it red."
- Align terminal output into a monospace grid with `.padEnd()` and `bold` headers.
- Always spell out the next action as a `backtick` command hint in gray.
- Resolve every `ora` spinner into a terminal ✓/✗ line.
- Keep web and terminal reading as one brand: lime accent, near-black, calm-by-default.

**Don't:**
- Hardcode hex colors in CLI output — use `chalk`'s semantic names so the user's theme is respected.
- Over-color the terminal — a wall of green/yellow destroys the signal that color is supposed to carry.
- Invent new status glyphs beyond the fixed set, or new chalk roles (avoid `magenta`/`blue` unless truly one-off).
- Emit emojis or decorative flair (repo hard rule: no emojis anywhere).
- Use toasts or spinner-that-never-ends UX — success is a quiet ✓, errors are inline red with a fix hint.
- Drift the web surface off lime + Geist; the landing and webview must stay a single palette.
