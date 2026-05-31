import { COMPARISON_HTML } from './comparison';

// GA4 measurement ID. Empty string = no snippet emitted.
// Property: "Phoenix Labs" account → "agents-cli.sh" GA4 property
//          (account 391921835 / property 533711132 / stream 14401886097)
const GA4_MEASUREMENT_ID = 'G-7J19GGKV2L';

const gaSnippet = GA4_MEASUREMENT_ID
  ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA4_MEASUREMENT_ID}', { anonymize_ip: true });
</script>`
  : '';

export const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agents · the open client for AI coding agents</title>
<meta name="description" content="The open client for AI coding agents. Pin versions, swap models, rotate accounts, drive a browser, spawn parallel teams, schedule on cron — one interface across Claude, Codex, Gemini, Cursor.">
<meta property="og:title" content="agents · the open client for AI coding agents">
<meta property="og:description" content="One interface across Claude, Codex, Gemini, Cursor. Pin versions, swap models, rotate accounts, drive browsers, spawn parallel teams, schedule on cron.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://agents-cli.sh/">
<meta property="og:image" content="https://agents-cli.sh/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="agents — the open client for AI coding agents. Pin versions, swap models, rotate accounts, drive a browser, parallel teams, cron.">
<meta property="og:site_name" content="agents-cli">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="agents · the open client for AI coding agents">
<meta name="twitter:description" content="One interface across Claude, Codex, Gemini, Cursor. Pin versions, swap models, rotate accounts, drive browsers, spawn parallel teams, schedule on cron.">
<meta name="twitter:image" content="https://agents-cli.sh/og.png">
<meta name="twitter:image:alt" content="agents — the open client for AI coding agents.">
<link rel="canonical" href="https://agents-cli.sh/">
<meta name="theme-color" content="#0a0a0a">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://agents-cli.sh/#software",
      "name": "agents-cli",
      "alternateName": ["agents", "ag"],
      "url": "https://agents-cli.sh/",
      "image": "https://agents-cli.sh/og.png",
      "description": "The open client for AI coding agents. Pin versions, swap models, rotate accounts, drive a browser, spawn parallel teams, schedule on cron — one interface across Claude, Codex, Gemini, Cursor.",
      "applicationCategory": "DeveloperApplication",
      "applicationSubCategory": "CommandLineTool",
      "operatingSystem": ["macOS", "Linux", "Windows"],
      "downloadUrl": "https://www.npmjs.com/package/@phnx-labs/agents-cli",
      "installUrl": "https://agents-cli.sh/",
      "softwareRequirements": "Node.js or Bun",
      "license": "MIT",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
      "publisher": { "@id": "https://agents-cli.sh/#org" },
      "featureList": [
        "Pin agent CLI versions per project",
        "Swap underlying models via OpenRouter profiles (Kimi, MiniMax, GLM, Qwen, DeepSeek)",
        "Rotate across multiple accounts to avoid rate limits",
        "Parallel agent teams with DAG dependencies",
        "Browser automation via Chrome DevTools Protocol",
        "Cross-agent session search",
        "Cron-scheduled agent routines",
        "Keychain-backed secrets bundles",
        "Sync agent memory across machines"
      ]
    },
    {
      "@type": "Organization",
      "@id": "https://agents-cli.sh/#org",
      "name": "Phoenix Labs",
      "url": "https://byphoenix.com/",
      "sameAs": [
        "https://github.com/phnx-labs",
        "https://www.npmjs.com/package/@phnx-labs/agents-cli"
      ]
    },
    {
      "@type": "WebSite",
      "@id": "https://agents-cli.sh/#website",
      "url": "https://agents-cli.sh/",
      "name": "agents-cli",
      "publisher": { "@id": "https://agents-cli.sh/#org" }
    }
  ]
}
</script>
<link rel="icon" href="/favicon.svg">
${gaSnippet}
<style>
*,*::before,*::after { box-sizing: border-box; }
html { background: #0a0a0a; }
body { margin: 0; padding: 0; background: #0a0a0a; color: #e8e8e8; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 15px; line-height: 1.7; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 24px 120px; }
.newsbar { border-bottom: 1px solid #1a1a1a; background: #0c0c0c; font-size: 12px; color: #777; }
.newsbar a { display: block; max-width: 1040px; margin: 0 auto; padding: 10px 24px; color: #888; text-decoration: none; letter-spacing: 0.01em; }
.newsbar a:hover { color: #a3e635; }
.newsbar .tag { display: inline-block; padding: 1px 6px; margin-right: 8px; border: 1px solid #333; border-radius: 3px; color: #a3e635; font-size: 11px; }
nav { display: flex; gap: 24px; font-size: 13px; color: #666; margin-bottom: 56px; }
nav a { color: #666; text-decoration: none; }
nav a:hover { color: #a3e635; }
h1 { font-size: 56px; font-weight: 500; letter-spacing: -0.03em; margin: 0 0 24px; color: #fff; }
h2 { font-size: 22px; font-weight: 500; letter-spacing: -0.01em; margin: 0 0 14px; color: #fff; }
h3 { font-size: 15px; font-weight: 500; margin: 32px 0 8px; color: #fff; }
p { margin: 0 0 16px; color: #b8b8b8; }
a { color: #a3e635; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
pre, code { font-family: inherit; }
pre { background: #141414; border: 1px solid #222; border-radius: 6px; padding: 16px 20px; margin: 0; overflow-x: auto; font-size: 14px; color: #e8e8e8; line-height: 1.6; }
p code, li code { background: #141414; border: 1px solid #222; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #d8d8d8; }
ul { list-style: none; padding: 0; margin: 16px 0 24px; }
ul li { padding: 6px 0 6px 20px; color: #b8b8b8; position: relative; }
ul li::before { content: "\\2192"; position: absolute; left: 0; color: #555; }
.dim { color: #666; }
.muted { color: #777; font-size: 13px; }

/* HERO */
.hero { display: grid; grid-template-columns: 1fr; gap: 48px; align-items: center; margin-bottom: 56px; }
.hero h1 { margin: 0 0 20px; }
.wordmark { display: block; width: 100%; max-width: 320px; height: auto; margin: 0 0 24px; }
.hero-lede { font-size: 20px; color: #e8e8e8; margin: 0 0 32px; max-width: 480px; line-height: 1.5; }
.hero-proof { display: block; width: 100%; max-width: 420px; height: auto; margin-left: auto; }
@media (min-width: 900px) { .hero { grid-template-columns: 1.1fr 0.9fr; gap: 64px; margin-bottom: 80px; } }

/* TABBED INSTALL */
.install-widget { border: 1px solid #222; border-radius: 8px; background: #0f0f0f; overflow: hidden; max-width: 480px; }
.install-tabs { display: flex; border-bottom: 1px solid #1a1a1a; background: #0c0c0c; }
.install-tab { flex: 1; background: transparent; border: 0; border-bottom: 2px solid transparent; color: #777; font-family: inherit; font-size: 13px; padding: 12px 16px; cursor: pointer; transition: all 0.15s ease; }
.install-tab:hover { color: #ccc; }
.install-tab.active { color: #a3e635; border-bottom-color: #a3e635; }
.install-row { display: flex; align-items: center; gap: 12px; padding: 16px 20px; font-size: 14px; }
.install-row .prompt { color: #555; user-select: none; }
.install-row .cmd { color: #e8e8e8; flex: 1; white-space: nowrap; overflow-x: auto; }
.install-row .cmd .accent { color: #a3e635; }
.install-row button { background: transparent; border: 1px solid #333; color: #999; padding: 4px 10px; border-radius: 4px; font-family: inherit; font-size: 12px; cursor: pointer; transition: all 0.15s ease; flex-shrink: 0; }
.install-row button:hover, .install-row button.copied { border-color: #a3e635; color: #a3e635; }
.install-pane { display: none; }
.install-pane.active { display: block; }
.install-foot { color: #666; font-size: 12px; margin-top: 12px; }

/* DEMO VIDEO */
.hero-video { position: relative; margin: 0 0 96px; border: 1px solid #1a1a1a; border-radius: 8px; overflow: hidden; background: #000; box-shadow: 0 0 0 1px rgba(163,230,53,0.04), 0 24px 48px -24px rgba(0,0,0,0.6); }
.hero-video video { display: block; width: 100%; height: auto; }
.sound-toggle { position: absolute; bottom: 12px; right: 12px; width: 36px; height: 36px; border-radius: 999px; border: 1px solid rgba(163,230,53,0.35); background: rgba(10,10,10,0.72); backdrop-filter: blur(8px); color: #a3e635; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: all 0.15s ease; opacity: 0.75; }
.sound-toggle:hover { opacity: 1; border-color: #a3e635; background: rgba(163,230,53,0.1); }
.sound-toggle svg { width: 16px; height: 16px; }

/* GROUPED SECTIONS */
.group { margin: 0 0 96px; }
.group-head { display: flex; align-items: baseline; gap: 16px; margin-bottom: 40px; padding-bottom: 16px; border-bottom: 1px solid #1a1a1a; }
.group-head h1.group-title { font-size: 32px; font-weight: 500; letter-spacing: -0.02em; margin: 0; color: #fff; }
.group-head .group-idx { color: #444; font-size: 13px; }
.feature { display: flex; flex-direction: column; gap: 24px; margin: 0 0 56px; align-items: stretch; }
.feature:last-child { margin-bottom: 0; }
.feature .copy h2 { margin-top: 0; }
.feature .copy p { margin-bottom: 0; }
.feature .demo { min-width: 0; }
.feature .demo pre { margin: 0; font-size: 13px; }
@media (min-width: 760px) {
  .feature { flex-direction: row; gap: 48px; align-items: center; }
  .feature.flip { flex-direction: row-reverse; }
  .feature .copy { flex: 0 1 42%; }
  .feature .demo { flex: 1 1 58%; }
}

/* SECTION HEADS */
.why, .agents-block, .install-full { margin: 0 0 96px; }
.why h2, .comparison-wrap h2, .agents-block h2, .install-full h2 { font-size: 28px; font-weight: 500; letter-spacing: -0.02em; margin: 0 0 24px; }
.why h2 { font-size: 32px; }
.install-full { margin-bottom: 64px; }
.install-full pre { margin: 0; }

/* CHIPS */
.agent-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.agent-chip { display: inline-flex; align-items: center; padding: 6px 12px; border: 1px solid #222; border-radius: 999px; background: #0f0f0f; color: #999; font-size: 13px; transition: all 0.15s ease; }
.agent-chip:hover { border-color: #a3e635; color: #e8e8e8; }

.stack-note { margin: 0 0 64px; padding: 16px 20px; background: #0f0f0f; border: 1px solid #1a1a1a; border-radius: 6px; color: #888; font-size: 13px; }
.stack-note strong { color: #a3e635; font-weight: 500; }

/* FOOTER */
footer { margin-top: 96px; padding-top: 40px; border-top: 1px solid #1a1a1a; font-size: 13px; color: #666; }
.footer-grid { display: grid; grid-template-columns: 1fr; gap: 32px; margin-bottom: 32px; }
@media (min-width: 700px) { .footer-grid { grid-template-columns: repeat(3, 1fr); } }
.footer-col h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; color: #888; margin: 0 0 12px; }
.footer-col ul { margin: 0; }
.footer-col li { padding: 4px 0; }
.footer-col li::before { content: none; }
.footer-col a { color: #999; }
.footer-col a:hover { color: #a3e635; }
.footer-foot { display: flex; justify-content: space-between; padding-top: 24px; border-top: 1px solid #141414; color: #555; }
.footer-foot a { color: #888; }

@media (max-width: 600px) {
  main { padding: 24px 20px 80px; }
  h1 { font-size: 42px; }
  nav { margin-bottom: 40px; }
  .group-head h1.group-title { font-size: 24px; }
  .hero-lede { font-size: 17px; }
}
</style>
</head>
<body>
<div class="newsbar">
  <a href="/changelog"><span class="tag">v1.20</span>Grok Build CLI support →</a>
</div>
<main>
<nav>
  <a href="/">home</a>
  <a href="#install">install</a>
  <a href="/changelog">changelog</a>
  <a href="https://github.com/phnx-labs/agents-cli">github</a>
  <a href="https://www.npmjs.com/package/@phnx-labs/agents-cli">npm</a>
</nav>

<section class="hero">
  <div class="hero-left">
    <h1><img src="/wordmark.svg" alt="agents" class="wordmark" width="320" height="80"></h1>
    <p class="hero-lede">One CLI for every coding agent. Pin, swap, rotate, parallel.</p>
    <div class="install-widget" id="install-widget">
      <div class="install-tabs" role="tablist">
        <button class="install-tab active" data-tab="curl" role="tab" type="button">curl</button>
        <button class="install-tab" data-tab="bun" role="tab" type="button">bun</button>
        <button class="install-tab" data-tab="npm" role="tab" type="button">npm</button>
      </div>
      <div class="install-pane active" data-pane="curl">
        <div class="install-row">
          <span class="prompt">$</span>
          <span class="cmd"><span class="accent">curl</span> -fsSL agents-cli.sh | sh</span>
          <button data-copy="curl -fsSL agents-cli.sh | sh">copy</button>
        </div>
      </div>
      <div class="install-pane" data-pane="bun">
        <div class="install-row">
          <span class="prompt">$</span>
          <span class="cmd"><span class="accent">bun</span> install -g @phnx-labs/agents-cli</span>
          <button data-copy="bun install -g @phnx-labs/agents-cli">copy</button>
        </div>
      </div>
      <div class="install-pane" data-pane="npm">
        <div class="install-row">
          <span class="prompt">$</span>
          <span class="cmd"><span class="accent">npm</span> install -g @phnx-labs/agents-cli</span>
          <button data-copy="npm install -g @phnx-labs/agents-cli">copy</button>
        </div>
      </div>
    </div>
    <p class="install-foot">also available as <code>ag</code>.</p>
  </div>
  <div class="hero-right">
    <img src="/benchmark.svg" alt="parallel speedup" class="hero-proof" width="420" height="280">
  </div>
</section>

<div class="hero-video">
  <video id="demo-video" src="/demo.mp4" poster="/demo-poster.jpg" autoplay muted loop playsinline preload="metadata"></video>
  <button class="sound-toggle" id="sound-toggle" type="button" aria-label="Unmute">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>
  </button>
</div>

<section class="group">
  <header class="group-head">
    <h1 class="group-title">Run agents</h1>
    <span class="group-idx">01</span>
  </header>

  <div class="feature">
    <div class="copy">
      <h2>Run any model through any CLI</h2>
      <p>Keep Claude Code's interface, swap in Kimi K2.5, MiniMax M2.5, GLM 5, Qwen3 Coder, or DeepSeek through OpenRouter. One key in your Keychain, every preset wired up. Run the model you want at the price you want.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents profiles add kimi
<span class="dim">$</span> agents run kimi <span class="dim">"refactor the queue worker"</span></pre>
    </div>
  </div>

  <div class="feature flip">
    <div class="copy">
      <h2>Rotate across accounts — never hit a usage limit</h2>
      <p>Have multiple Claude logins? <code>--rotate</code> picks the least-used one automatically. <code>agents usage</code> shows the rate-limit gauge per agent so you can plan ahead. One subscription, multiple windows, zero wasted quota.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents run claude --rotate <span class="dim">"run the full test suite"</span>
<span class="dim">$</span> agents usage</pre>
    </div>
  </div>

  <div class="feature">
    <div class="copy">
      <h2>Chain agents in a pipeline</h2>
      <p>Unix pipe composition across different models. Each agent resolves to the project-pinned version, with the right skills and MCP servers already synced. Chain by strength, swap one for another, script them in CI — the interface stays the same.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents run claude <span class="dim">"Find auth vulnerabilities in src/"</span> \\
    | agents run codex  <span class="dim">"Fix the issues Claude found"</span> \\
    | agents run gemini <span class="dim">"Write regression tests for the fixes"</span></pre>
    </div>
  </div>

  <div class="feature flip">
    <div class="copy">
      <h2>Pin versions per project</h2>
      <p><code>cd</code> into the project and every <code>agents</code> call resolves to those versions automatically. Like <code>.nvmrc</code>, but for AI. Nobody else does this.</p>
    </div>
    <div class="demo">
<pre><span class="dim">#</span> agents.yaml
agents:
  claude: "2.1.113"
  codex: "0.116.0"</pre>
    </div>
  </div>
</section>

<section class="group">
  <header class="group-head">
    <h1 class="group-title">Run them in parallel</h1>
    <span class="group-idx">02</span>
  </header>

  <div class="feature">
    <div class="copy">
      <h2>Parallel agents, one command</h2>
      <p>DAG dependencies (<code>--after</code>), isolated worktrees per teammate, live status. Spawn five Claudes and two Codex on the same task, wind them down with <code>agents teams disband</code>.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents teams create pricing
<span class="dim">$</span> agents teams add pricing claude <span class="dim">"rewrite endpoint"</span> -n be
<span class="dim">$</span> agents teams add pricing codex <span class="dim">"build route"</span> -n fe
<span class="dim">$</span> agents teams add pricing claude <span class="dim">"run tests"</span> -n qa --after be,fe
<span class="dim">$</span> agents teams start pricing --watch</pre>
    </div>
  </div>

  <div class="feature flip">
    <div class="copy">
      <h2>grep your AI history</h2>
      <p>Every transcript from every agent, indexed and searchable. Find that fix from Tuesday — doesn't matter which CLI wrote it. Replay as markdown, filter by project, stream live with <code>sessions tail</code>.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents sessions <span class="dim">"stripe webhook signature"</span>
<span class="dim">$</span> agents sessions a7f3e2c1 --markdown</pre>
    </div>
  </div>
</section>

<section class="group">
  <header class="group-head">
    <h1 class="group-title">Configure once</h1>
    <span class="group-idx">03</span>
  </header>

  <div class="feature">
    <div class="copy">
      <h2>Install once, sync everywhere</h2>
      <p>Skills, MCP servers, slash commands, hooks, permissions — installed once, synced to every active agent version. No more <code>claude mcp add</code> then <code>codex mcp add</code> then editing Gemini's config file by hand.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents skills add gh:yourname/python-expert
<span class="dim">$</span> agents install mcp:com.notion/mcp
<span class="dim">$</span> agents commands add gh:yourname/commands</pre>
    </div>
  </div>

  <div class="feature flip">
    <div class="copy">
      <h2>Your agent memory, on every machine</h2>
      <p>rsync your sessions and config between laptop, desktop, and server. <code>attach</code> points <code>~/.claude/</code> (and friends) at the synced location so sessions write directly to the shared drive.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents drive remote you@desktop.local
<span class="dim">$</span> agents drive push
<span class="dim">$</span> agents drive attach</pre>
    </div>
  </div>

  <div class="feature">
    <div class="copy">
      <h2>One config repo, every harness</h2>
      <p><code>~/.agents/</code> is the canonical config source. Write your commands as markdown, your rules as <code>AGENTS.md</code>, your hooks as scripts — and <code>agents-cli</code> syncs them into each harness's native format: markdown for Claude and Gemini, TOML for Codex, <code>.cursorrules</code> for Cursor. <a href="https://github.com/phnx-labs/agents-cli">Fork it</a> and push your own via <code>agents repo push</code>.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> tree ~/.agents
~/.agents/
├── commands/      <span class="dim"># slash commands</span>
├── skills/        <span class="dim"># reusable knowledge packs</span>
├── mcp/           <span class="dim"># MCP server definitions</span>
├── hooks/         <span class="dim"># lifecycle hooks</span>
├── memory/        <span class="dim"># agent instructions (AGENTS.md)</span>
└── permissions/</pre>
    </div>
  </div>
</section>

<section class="group">
  <header class="group-head">
    <h1 class="group-title">Run them in the background</h1>
    <span class="group-idx">04</span>
  </header>

  <div class="feature">
    <div class="copy">
      <h2>A browser your agents can drive</h2>
      <p>Full Chrome DevTools Protocol — navigate, click, type, screenshot, read console + network, record video. Hook it into any agent run. Replaces a cloud browser service with a local one you already have logged in.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents browser start work
<span class="dim">$</span> agents browser navigate https://example.com
<span class="dim">$</span> agents browser click <span class="dim">ref_3</span>
<span class="dim">$</span> agents browser screenshot
<span class="dim">$</span> agents browser console</pre>
    </div>
  </div>

  <div class="feature flip">
    <div class="copy">
      <h2>Schedule agents on a cron</h2>
      <p>Recurring background work, plus one-shot <code>--at "14:30"</code>. Scheduler auto-starts on first add. Standups, weekly digests, nightly audits — your agents working while you sleep.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents routines add standup \\
    --schedule <span class="dim">"0 9 * * 1-5"</span> \\
    --agent claude \\
    --prompt <span class="dim">"Draft a standup from yesterday's git log"</span></pre>
    </div>
  </div>

  <div class="feature">
    <div class="copy">
      <h2>Keychain-backed secrets</h2>
      <p>No plaintext <code>.env</code> files, no leaked tokens in shell history. Bundles live in macOS Keychain, iCloud-synced across your machines, injected as env vars only at run time.</p>
    </div>
    <div class="demo">
<pre><span class="dim">$</span> agents secrets create prod
<span class="dim">$</span> agents secrets add prod STRIPE_API_KEY
<span class="dim">$</span> agents run claude <span class="dim">"deploy the worker"</span> --secrets prod</pre>
    </div>
  </div>
</section>

<section class="why">
  <h2>Why</h2>
  <ul>
    <li>You use multiple coding agents and their configs drift</li>
    <li>You want a skill, MCP server, or slash command installed everywhere at once</li>
    <li>You want to pin agent versions per project like <code>.nvmrc</code></li>
    <li>You want to chain agents in scripts, CI, or cron jobs</li>
    <li>You want it open, local, and yours — not a cloud SaaS</li>
  </ul>
</section>

<section class="comparison-wrap">
  <h2>vs every other way to run agents</h2>
  ${COMPARISON_HTML}
</section>

<section class="agents-block">
  <h2>Supported agents</h2>
  <div class="agent-chips">
    <span class="agent-chip">Claude Code</span>
    <span class="agent-chip">Codex</span>
    <span class="agent-chip">Gemini</span>
    <span class="agent-chip">Cursor</span>
    <span class="agent-chip">OpenCode</span>
    <span class="agent-chip">OpenClaw</span>
    <span class="agent-chip">Copilot</span>
    <span class="agent-chip">Amp</span>
    <span class="agent-chip">Kiro</span>
    <span class="agent-chip">Goose</span>
    <span class="agent-chip">Roo</span>
  </div>
</section>

<section class="install-full" id="install">
  <h2>Install</h2>
<pre><span class="dim">#</span> via curl
<span class="dim">$</span> curl -fsSL agents-cli.sh | sh

<span class="dim">#</span> via bun
<span class="dim">$</span> bun install -g @phnx-labs/agents-cli

<span class="dim">#</span> via npm
<span class="dim">$</span> npm install -g @phnx-labs/agents-cli</pre>
</section>

<div class="stack-note">Part of the <strong>open stack for AI coding agents</strong>. Cloud runner coming.</div>

<footer>
  <div class="footer-grid">
    <div class="footer-col">
      <h4>Product</h4>
      <ul>
        <li><a href="#install">Install</a></li>
        <li><a href="/changelog">Changelog</a></li>
        <li><a href="https://github.com/phnx-labs/agents-cli">GitHub</a></li>
        <li><a href="https://www.npmjs.com/package/@phnx-labs/agents-cli">npm</a></li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>Docs</h4>
      <ul>
        <li><a href="https://github.com/phnx-labs/agents-cli#readme">README</a></li>
        <li><a href="https://github.com/phnx-labs/agents-cli/tree/main/docs">Concepts</a></li>
        <li><a href="https://github.com/phnx-labs/agents-cli/issues">Issues</a></li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>Company</h4>
      <ul>
        <li><a href="https://byphoenix.com/">Phoenix Labs</a></li>
        <li><a href="https://github.com/phnx-labs/agents-cli/blob/main/LICENSE">MIT License</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-foot">
    <span>agents-cli · <span class="dim">made by phoenix</span></span>
    <a href="https://github.com/phnx-labs/agents-cli">github.com/phnx-labs/agents-cli</a>
  </div>
</footer>
</main>
<script>
document.querySelectorAll("[data-copy]").forEach(btn => {
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(btn.dataset.copy);
    const prev = btn.textContent;
    btn.textContent = "copied";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1200);
  });
});

(function(){
  const widget = document.getElementById("install-widget");
  if (!widget) return;
  const tabs = widget.querySelectorAll(".install-tab");
  const panes = widget.querySelectorAll(".install-pane");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle("active", t === tab));
      panes.forEach(p => p.classList.toggle("active", p.dataset.pane === name));
    });
  });
})();

(function(){
  const v = document.getElementById("demo-video");
  const b = document.getElementById("sound-toggle");
  if (!v || !b) return;
  const mutedIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
  const liveIcon  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
  b.addEventListener("click", () => {
    v.muted = !v.muted;
    b.innerHTML = v.muted ? mutedIcon : liveIcon;
    b.setAttribute("aria-label", v.muted ? "Unmute" : "Mute");
    if (!v.muted) { v.play().catch(()=>{}); }
  });
})();
</script>
</body>
</html>`;
