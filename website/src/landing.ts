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
<meta name="description" content="The open client for AI coding agents. Run Claude, Codex, Gemini, Cursor — same interface, on your machine.">
<meta property="og:title" content="agents · the open client for AI coding agents">
<meta property="og:description" content="Run Claude, Codex, Gemini, Cursor — same interface, on your machine.">
<meta name="theme-color" content="#0a0a0a">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='28' font-family='monospace' fill='%23a3e635'%3E%3E%3C/text%3E%3C/svg%3E">
${gaSnippet}
<style>
*,*::before,*::after { box-sizing: border-box; }
html { background: #0a0a0a; }
body {
  margin: 0;
  padding: 0;
  background: #0a0a0a;
  color: #e8e8e8;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 15px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
main { max-width: 680px; margin: 0 auto; padding: 80px 24px 120px; }
.hero-video {
  position: relative;
  margin: 32px -40px 48px;
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
  background: #000;
  box-shadow: 0 0 0 1px rgba(163,230,53,0.04), 0 24px 48px -24px rgba(0,0,0,0.6);
}
.hero-video video { display: block; width: 100%; height: auto; }
.sound-toggle {
  position: absolute;
  bottom: 12px;
  right: 12px;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid rgba(163,230,53,0.35);
  background: rgba(10,10,10,0.72);
  backdrop-filter: blur(8px);
  color: #a3e635;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.15s ease;
  opacity: 0.75;
}
.sound-toggle:hover { opacity: 1; border-color: #a3e635; background: rgba(163,230,53,0.1); }
.sound-toggle svg { width: 16px; height: 16px; }
@media (max-width: 760px) { .hero-video { margin-left: -12px; margin-right: -12px; } }
nav { display: flex; gap: 24px; font-size: 13px; color: #666; margin-bottom: 96px; }
nav a { color: #666; text-decoration: none; }
nav a:hover { color: #a3e635; }
h1 { font-size: 56px; font-weight: 500; letter-spacing: -0.03em; margin: 0 0 24px; color: #fff; }
h2 { font-size: 20px; font-weight: 500; letter-spacing: -0.01em; margin: 72px 0 16px; color: #fff; }
h3 { font-size: 15px; font-weight: 500; margin: 32px 0 8px; color: #fff; }
p { margin: 0 0 16px; color: #b8b8b8; }
.lede { font-size: 18px; color: #e8e8e8; margin-bottom: 48px; max-width: 560px; }
.muted { color: #777; font-size: 13px; }
a { color: #a3e635; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
pre, code { font-family: inherit; }
pre {
  background: #141414;
  border: 1px solid #222;
  border-radius: 6px;
  padding: 16px 20px;
  margin: 16px 0 24px;
  overflow-x: auto;
  font-size: 14px;
  color: #e8e8e8;
}
p code { background: #141414; border: 1px solid #222; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #d8d8d8; }
.hero-install {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #141414;
  border: 1px solid #222;
  border-radius: 6px;
  padding: 14px 20px;
  font-size: 14px;
  margin-bottom: 16px;
}
.hero-install .prompt { color: #555; user-select: none; }
.hero-install .cmd { color: #a3e635; flex: 1; }
.hero-install button {
  background: transparent;
  border: 1px solid #333;
  color: #999;
  padding: 4px 10px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.hero-install button:hover { border-color: #a3e635; color: #a3e635; }
.hero-install button.copied { border-color: #a3e635; color: #a3e635; }
.stack-note {
  margin: 72px 0 0;
  padding: 16px 20px;
  background: #0f0f0f;
  border: 1px solid #1a1a1a;
  border-radius: 6px;
  color: #888;
  font-size: 13px;
}
.stack-note strong { color: #a3e635; font-weight: 500; }
footer {
  margin-top: 120px;
  padding-top: 32px;
  border-top: 1px solid #1a1a1a;
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: #555;
}
footer a { color: #888; }
ul { list-style: none; padding: 0; margin: 16px 0 24px; }
ul li { padding: 6px 0; color: #b8b8b8; position: relative; padding-left: 20px; }
ul li::before { content: "\\2192"; position: absolute; left: 0; color: #555; }
ul li code { background: #141414; border: 1px solid #222; padding: 1px 6px; border-radius: 3px; font-size: 13px; color: #d8d8d8; }
.dim { color: #666; }
@media (max-width: 600px) {
  main { padding: 56px 20px 80px; }
  h1 { font-size: 42px; }
  nav { margin-bottom: 64px; }
}
</style>
</head>
<body>
<main>
<nav>
  <a href="/">home</a>
  <a href="/changelog">changelog</a>
  <a href="https://github.com/phnx-labs/agents-cli">github</a>
  <a href="https://www.npmjs.com/package/@phnx-labs/agents-cli">npm</a>
</nav>

<h1>agents</h1>
<p class="lede">The open client for AI coding agents. Run Claude, Codex, Gemini, Cursor — same interface, on your machine.</p>

<div class="hero-video">
  <video id="demo-video" src="/demo.mp4" poster="/demo-poster.jpg" autoplay muted loop playsinline preload="metadata"></video>
  <button class="sound-toggle" id="sound-toggle" type="button" aria-label="Unmute">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>
  </button>
</div>

<div class="hero-install">
  <span class="prompt">$</span>
  <span class="cmd">curl -fsSL agents-cli.sh | sh</span>
  <button data-copy="curl -fsSL agents-cli.sh | sh">copy</button>
</div>
<p class="muted">Or <code>npm install -g @phnx-labs/agents-cli</code> — also available as <code>ag</code>.</p>

<h2>Chain agents in a pipeline</h2>
<pre><span class="dim">$</span> agents run claude <span class="dim">"Find auth vulnerabilities in src/"</span> \\
    | agents run codex  <span class="dim">"Fix the issues Claude found"</span> \\
    | agents run gemini <span class="dim">"Write regression tests for the fixes"</span></pre>
<p>Unix pipe composition across different models. Each agent resolves to the project-pinned version, with the right skills and MCP servers already synced. Chain by strength, swap one for another, script them in CI — the interface stays the same.</p>

<h2>Pin versions per project</h2>
<pre><span class="dim">#</span> agents.yaml
agents:
  claude: "2.1.113"
  codex: "0.116.0"</pre>
<p><code>cd</code> into the project and every <code>agents</code> call resolves to those versions automatically. Like <code>.nvmrc</code>, but for AI. Nobody else does this.</p>

<h2>Install skills, MCP servers, and commands once</h2>
<pre><span class="dim">$</span> agents skills add gh:yourname/python-expert
<span class="dim">$</span> agents install mcp:com.notion/mcp
<span class="dim">$</span> agents commands add gh:yourname/commands</pre>
<p>Skills, MCP servers, slash commands, hooks, permissions — installed once, synced to every active agent version. No more <code>claude mcp add</code> then <code>codex mcp add</code> then editing Gemini's config file by hand.</p>

<h2>One config repo, every harness</h2>
<pre><span class="dim">$</span> tree ~/.agents
~/.agents/
├── commands/      <span class="dim"># slash commands</span>
├── skills/        <span class="dim"># reusable knowledge packs</span>
├── mcp/           <span class="dim"># MCP server definitions</span>
├── hooks/         <span class="dim"># lifecycle hooks</span>
├── memory/        <span class="dim"># agent instructions (AGENTS.md)</span>
└── permissions/</pre>
<p>
<code>~/.agents/</code> is the canonical config source. Write your commands as markdown, your rules as <code>AGENTS.md</code>, your hooks as scripts — and <code>agents-cli</code> syncs them into each harness's native format: markdown for Claude and Gemini, TOML for Codex, <code>.cursorrules</code> for Cursor. One repo, every agent in sync. <a href="https://github.com/phnx-labs/agents-cli">Fork it</a> and push your own via <code>agents repo push</code>.
</p>

<h2>Why</h2>
<ul>
  <li>You use multiple coding agents and their configs drift</li>
  <li>You want a skill, MCP server, or slash command installed everywhere at once</li>
  <li>You want to pin agent versions per project like <code>.nvmrc</code></li>
  <li>You want to chain agents in scripts, CI, or cron jobs</li>
  <li>You want it open, local, and yours — not a cloud SaaS</li>
</ul>

<h2>Supported agents</h2>
<p class="dim">Claude Code · Codex · Gemini · Cursor · OpenCode · OpenClaw · Copilot · Amp · Kiro · Goose · Roo</p>

<h2>Install</h2>
<pre><span class="dim">#</span> via curl
<span class="dim">$</span> curl -fsSL agents-cli.sh | sh

<span class="dim">#</span> via bun
<span class="dim">$</span> bun install -g @phnx-labs/agents-cli

<span class="dim">#</span> via npm
<span class="dim">$</span> npm install -g @phnx-labs/agents-cli</pre>

<div class="stack-note">Part of the <strong>open stack for AI coding agents</strong>. Cloud runner coming.</div>

<footer>
  <span>agents-cli · <span class="dim">made by phoenix</span></span>
  <a href="https://github.com/phnx-labs/agents-cli">github.com/phnx-labs/agents-cli</a>
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
