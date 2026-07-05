/**
 * Self-contained HTML page for `agents serve`. No framework, no external assets
 * — a single inline <style> + <script> that subscribes to /events (SSE) and
 * re-renders the panels on each snapshot. Terminal-coded per the agents-cli
 * brand: #0a0a0a bg, #a3e635 lime accent, JetBrains Mono.
 */
export function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>agents serve</title>
<style>
  :root {
    --bg: #0a0a0a; --panel: #121212; --border: #262626; --fg: #e5e5e5;
    --dim: #737373; --accent: #a3e635; --add: #4ade80; --del: #f87171; --hunk: #60a5fa;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 13px; line-height: 1.5;
  }
  header {
    position: sticky; top: 0; z-index: 10; background: var(--bg);
    border-bottom: 1px solid var(--border); padding: 12px 20px;
    display: flex; align-items: center; gap: 12px;
  }
  header .mark { color: var(--accent); font-weight: 700; letter-spacing: .5px; }
  header .status { color: var(--dim); }
  header .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--del); margin-right: 6px; vertical-align: middle; }
  header .dot.live { background: var(--accent); }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; display: grid; gap: 24px; }
  h2 { font-size: 14px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 6px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 1px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 14px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .muted { color: var(--dim); }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); }
  .badge.running { color: var(--accent); border-color: var(--accent); }
  .badge.completed { color: var(--add); border-color: var(--add); }
  .badge.failed { color: var(--del); border-color: var(--del); }
  a { color: var(--hunk); text-decoration: none; }
  a:hover { text-decoration: underline; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: var(--dim); }
  pre.diff { overflow-x: auto; background: #0d0d0d; border: 1px solid var(--border); border-radius: 4px; padding: 10px; margin: 8px 0 0; white-space: pre; }
  pre.diff .a { color: var(--add); } pre.diff .d { color: var(--del); } pre.diff .h { color: var(--hunk); } pre.diff .m { color: var(--dim); }
  .err { color: var(--del); }
  .empty { color: var(--dim); font-style: italic; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--dim); font-weight: 500; }
</style>
</head>
<body>
<header>
  <span class="mark">agents serve</span>
  <span class="status"><span class="dot" id="dot"></span><span id="conn">connecting…</span></span>
  <span class="status" id="ts"></span>
</header>
<main>
  <section><h2>Teams &amp; Diffs</h2><div id="teams"></div></section>
  <section><h2>Routines</h2><div id="routines"></div></section>
  <section><h2>Cloud</h2><div id="cloud"></div></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// href allowlist: only http(s) URLs are linkable. esc() blocks attribute
// breakout, but a javascript:/data: URL would still execute on click — so a
// non-http(s) pr_url renders as an inert '#' rather than a live link.
const safeUrl = (u) => { const s = String(u == null ? '' : u); return /^https?:\\/\\//i.test(s) ? s : '#'; };
function colorDiff(text) {
  return esc(text).split('\\n').map((line) => {
    if (line.startsWith('+')) return '<span class="a">' + line + '</span>';
    if (line.startsWith('-')) return '<span class="d">' + line + '</span>';
    if (line.startsWith('@@')) return '<span class="h">' + line + '</span>';
    if (line.startsWith('diff ') || line.startsWith('index ')) return '<span class="m">' + line + '</span>';
    return line;
  }).join('\\n');
}
function panelError(el, error) { el.innerHTML = '<div class="card err">error: ' + esc(error) + '</div>'; }

function renderTeams(res) {
  const el = $('teams');
  if (!res.ok) return panelError(el, res.error);
  if (!res.data.length) { el.innerHTML = '<div class="empty">no teams</div>'; return; }
  el.innerHTML = res.data.map((t) => {
    const agents = t.agents.map((a) =>
      '<div class="row"><span>' + esc(a.name || a.agent_id.slice(0,8)) +
      ' <span class="muted">' + esc(a.agent_type) + '</span>' +
      (a.pr_url ? ' <a href="' + esc(safeUrl(a.pr_url)) + '" target="_blank">PR</a>' : '') +
      '</span><span class="badge ' + esc(a.status) + '">' + esc(a.status) + '</span></div>'
    ).join('');
    const worktrees = t.worktrees.map((w) => {
      const body = w.diff
        ? '<details><summary>diff · ' + esc(w.worktree_name || w.worktree_path) + '</summary><pre class="diff">' + colorDiff(w.diff) + '</pre></details>'
        : '<div class="muted">' + esc(w.worktree_name || w.worktree_path) + ' — no uncommitted changes</div>';
      return body;
    }).join('');
    return '<div class="card"><div class="row"><strong>' + esc(t.task_name) + '</strong>' +
      '<span class="muted">' + t.running + ' running · ' + t.completed + ' done · ' + t.failed + ' failed</span></div>' +
      agents + worktrees + '</div>';
  }).join('');
}
function renderRoutines(res) {
  const el = $('routines');
  if (!res.ok) return panelError(el, res.error);
  if (!res.data.length) { el.innerHTML = '<div class="empty">no routines</div>'; return; }
  el.innerHTML = '<div class="card"><table><tr><th>name</th><th>schedule</th><th>agent</th><th>enabled</th></tr>' +
    res.data.map((j) => '<tr><td>' + esc(j.name) + '</td><td class="muted">' + esc(j.schedule) + '</td><td>' +
      esc(j.workflow ? 'wf:' + j.workflow : j.agent) + '</td><td>' + (j.enabled ? 'yes' : '<span class="muted">no</span>') + '</td></tr>').join('') +
    '</table></div>';
}
function renderCloud(res) {
  const el = $('cloud');
  if (!res.ok) return panelError(el, res.error);
  if (!res.data.length) { el.innerHTML = '<div class="empty">no cloud tasks</div>'; return; }
  el.innerHTML = '<div class="card"><table><tr><th>id</th><th>provider</th><th>status</th><th>repo</th><th></th></tr>' +
    res.data.map((c) => '<tr><td>' + esc(c.id.slice(0,10)) + '</td><td>' + esc(c.provider) + '</td><td><span class="badge ' + esc(c.status) + '">' +
      esc(c.status) + '</span></td><td class="muted">' + esc(c.repo || '') + '</td><td>' +
      (c.prUrl ? '<a href="' + esc(safeUrl(c.prUrl)) + '" target="_blank">PR</a>' : '') + '</td></tr>').join('') +
    '</table></div>';
}
function render(state) {
  renderTeams(state.teams); renderRoutines(state.routines); renderCloud(state.cloud);
  $('ts').textContent = 'updated ' + new Date(state.generated_at).toLocaleTimeString();
}
function setConn(live) {
  $('dot').className = 'dot' + (live ? ' live' : '');
  $('conn').textContent = live ? 'live' : 'reconnecting…';
}
const src = new EventSource('/events');
src.addEventListener('state', (e) => { setConn(true); render(JSON.parse(e.data)); });
src.onerror = () => setConn(false);
</script>
</body>
</html>`;
}
