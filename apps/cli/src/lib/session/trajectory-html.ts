/**
 * Render a {@link SessionTrajectory} as ONE self-contained HTML page for
 * `agents sessions trace` (single-session layout).
 *
 * Self-contained on purpose, exactly like `share-html.ts`: an inline `<style>`,
 * an inline SVG waterfall, no external asset, no CDN, no web font, no
 * `artifacts-cli` dependency. The page is safe to open on any box or hand to a
 * person. All transcript-derived text is escaped with `escapeHtml`, and the
 * labels are already secret-redacted upstream in `buildTrajectory`.
 *
 * Terminal-coded per the agents-cli brand (#0a0a0a bg, #a3e635 lime accent,
 * JetBrains Mono), light theme under `prefers-color-scheme: light`, with an
 * in-page toggle — the same shell `share-html.ts` ships.
 */
import { formatDuration, formatTokenCount } from './render.js';
import { escapeHtml } from './share-html.js';
import type { SessionTrajectory, TrajectoryStep } from './trajectory.js';
import type { TrajectoryComparison } from './trajectory-compare.js';
import type { LineageNode, SessionLineage } from './trajectory-lineage.js';

/** Color a tool bar by family; an error outcome overrides to red. */
function toolColor(step: TrajectoryStep): string {
  if (step.outcome === 'error') return '#f87171';
  if (step.kind === 'thinking') return '#3a3a55';
  const tool = (step.tool ?? '').toLowerCase();
  if (tool === 'bash' || tool === 'shell' || tool.includes('exec') || tool === 'run_command') return '#e0b341';
  if (tool === 'read' || tool === 'grep' || tool === 'glob' || tool === 'search' || tool === 'codebase_search') return '#4a9eff';
  if (tool === 'edit' || tool === 'write' || tool === 'notebookedit' || tool === 'multiedit') return '#7ee787';
  if (tool === 'task' || tool === 'agent') return '#b98cff';
  return '#8b98a5';
}

/** Precise per-step duration for the waterfall: "8m04s", "1.6s", "320ms". */
function formatStepDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** Axis tick labels in minutes across the span. */
function axisTicks(spanMs: number, count = 4): Array<{ frac: number; label: string }> {
  if (spanMs <= 0) return [{ frac: 0, label: '0m' }];
  const ticks: Array<{ frac: number; label: string }> = [];
  for (let i = 0; i <= count; i++) {
    const frac = i / count;
    const min = (spanMs * frac) / 60_000;
    ticks.push({ frac, label: min >= 1 ? `${Math.round(min)}m` : `${Math.round(spanMs * frac / 1000)}s` });
  }
  return ticks;
}

interface WaterfallGeometry {
  labelW: number;
  chartW: number;
  rowH: number;
  top: number;
}

const GEO: WaterfallGeometry = { labelW: 84, chartW: 620, rowH: 20, top: 34 };

function xForMs(startMs: number, spanMs: number): number {
  const frac = spanMs > 0 ? Math.min(1, Math.max(0, startMs / spanMs)) : 0;
  return GEO.labelW + frac * GEO.chartW;
}

function widthForMs(durationMs: number, spanMs: number): number {
  if (spanMs <= 0) return 3;
  return Math.max(3, (durationMs / spanMs) * GEO.chartW);
}

function renderWaterfallSvg(model: SessionTrajectory): string {
  const { steps, gaps, spanMs } = model;
  const height = GEO.top + steps.length * GEO.rowH + 16;
  const width = GEO.labelW + GEO.chartW + 40;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Session tool-call waterfall over time" xmlns="http://www.w3.org/2000/svg">`);

  // Axis line + minute ticks.
  const axisY = GEO.top - 10;
  parts.push(`<line x1="${GEO.labelW}" y1="${axisY}" x2="${GEO.labelW + GEO.chartW}" y2="${axisY}" class="axis" />`);
  for (const tick of axisTicks(spanMs)) {
    const x = GEO.labelW + tick.frac * GEO.chartW;
    parts.push(`<text x="${x.toFixed(1)}" y="${axisY - 3}" class="tick">${escapeHtml(tick.label)}</text>`);
  }

  // Idle-gap bands behind the rows.
  for (const gap of gaps) {
    const gx = xForMs(gap.startMs, spanMs);
    const gw = widthForMs(gap.durationMs, spanMs);
    parts.push(`<rect x="${gx.toFixed(1)}" y="${GEO.top}" width="${gw.toFixed(1)}" height="${steps.length * GEO.rowH}" class="gap" />`);
    parts.push(`<text x="${(gx + 3).toFixed(1)}" y="${GEO.top + 11}" class="gap-label">idle ${escapeHtml(formatStepDuration(gap.durationMs))}</text>`);
  }

  // One row per step.
  steps.forEach((step, i) => {
    const y = GEO.top + i * GEO.rowH;
    const barY = y + 3;
    const barH = GEO.rowH - 8;
    const x = xForMs(step.startMs, spanMs);
    const w = widthForMs(step.durationMs, spanMs);
    const color = toolColor(step);
    const laneLabel = escapeHtml(step.lane);
    const dur = formatStepDuration(step.durationMs);
    const estimatedAttrs = step.durationEstimated ? ' stroke-dasharray="3 2" stroke="' + color + '" fill-opacity="0.35"' : '';
    parts.push(`<a href="#step-${step.ordinal}">`);
    parts.push(`<text x="${GEO.labelW - 6}" y="${y + 13}" class="lane" text-anchor="end">${laneLabel}</text>`);
    parts.push(`<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barH}" rx="2" fill="${color}"${estimatedAttrs}><title>step ${step.ordinal} · ${escapeHtml(step.tool ?? step.kind)} · ${escapeHtml(dur)}${step.durationEstimated ? ' (est)' : ''}</title></rect>`);
    const textX = x + w + 4;
    if (textX < width - 30) {
      parts.push(`<text x="${textX.toFixed(1)}" y="${y + 13}" class="bar-label">${escapeHtml(clipLabel(step.label))} <tspan class="bar-dur">${escapeHtml(dur)}${step.outcome === 'error' ? ' ✗' : ''}</tspan></text>`);
    }
    parts.push(`</a>`);
  });

  parts.push('</svg>');
  return parts.join('\n');
}

function clipLabel(label: string): string {
  return label.length <= 46 ? label : `${label.slice(0, 45)}…`;
}

function renderTimeShare(model: SessionTrajectory): string {
  const entries = Object.entries(model.toolTimeShare).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '<p class="muted">No measured tool time.</p>';
  const rows = entries.map(([tool, share]) => {
    const pct = Math.round(share * 100);
    const color = toolColor({ ordinal: 0, kind: 'tool', tool, lane: tool, startMs: 0, durationMs: 0, durationEstimated: false, label: tool });
    return `<div class="share-row"><span class="share-name">${escapeHtml(tool)}</span>` +
      `<span class="share-bar"><span class="share-fill" style="width:${pct}%;background:${color}"></span></span>` +
      `<span class="share-pct">${pct}%</span></div>`;
  }).join('\n');
  return rows;
}

function renderStepDetail(model: SessionTrajectory): string {
  return model.steps.map((step) => {
    const color = toolColor(step);
    const outcome = step.outcome && step.outcome !== 'unknown'
      ? `<span class="outcome ${step.outcome}">${step.outcome}</span>` : '';
    const est = step.durationEstimated ? '<span class="est">estimated</span>' : '';
    const delegation = step.delegation ? `<span class="tag">${escapeHtml(step.delegation)}</span>` : '';
    const tokens = step.outputTokens ? `<span class="muted">${formatTokenCount(step.outputTokens)} out</span>` : '';
    const detail = step.detail ? `<pre class="detail">${escapeHtml(step.detail)}</pre>` : '';
    return `<div class="step" id="step-${step.ordinal}">
  <div class="step-head">
    <span class="dot" style="background:${color}"></span>
    <span class="step-ord">${step.ordinal}</span>
    <span class="step-tool">${escapeHtml(step.tool ?? step.kind)}</span>
    <span class="step-dur">${escapeHtml(formatStepDuration(step.durationMs))}</span>
    ${outcome} ${est} ${delegation} ${tokens}
  </div>
  <div class="step-label">${escapeHtml(step.label)}</div>
  ${detail}
</div>`;
  }).join('\n');
}

/** Render one session's trajectory as a self-contained HTML page. */
export function renderTrajectoryHtml(model: SessionTrajectory): string {
  const { session, stats } = model;
  const title = `${session.agent} · ${session.shortId || session.id}`;
  const model2 = session.model ? escapeHtml(session.model) : '';
  const turns = stats.userTurns + stats.assistantTurns;
  const metrics: string[] = [];
  metrics.push(`${formatDuration(model.spanMs)}`);
  metrics.push(`${stats.toolCount} tool${stats.toolCount === 1 ? '' : 's'}`);
  if (model.errorCount > 0) metrics.push(`${model.errorCount} error${model.errorCount === 1 ? '' : 's'}`);
  if (stats.outputTokens > 0) metrics.push(`${formatTokenCount(stats.outputTokens)} out`);
  if (session.costUsd) metrics.push(`$${session.costUsd.toFixed(2)}`);
  metrics.push(`${turns} turn${turns === 1 ? '' : 's'}`);
  const metricLine = metrics.map((m) => escapeHtml(m)).join(' · ');

  const chips: string[] = [];
  if (session.project) chips.push(`<span class="chip"><span class="k">project</span>${escapeHtml(session.project)}</span>`);
  if (session.mode) chips.push(`<span class="chip"><span class="k">mode</span>${escapeHtml(session.mode)}</span>`);
  if (session.gitBranch) chips.push(`<span class="chip"><span class="k">branch</span>${escapeHtml(session.gitBranch)}</span>`);
  if (session.ticketId) chips.push(`<span class="chip"><span class="k">ticket</span>${escapeHtml(session.ticketId)}</span>`);
  const date = (session.timestamp || '').slice(0, 10);
  if (date) chips.push(`<span class="chip"><span class="k">date</span>${escapeHtml(date)}</span>`);

  const gapNote = model.gaps.length > 0
    ? `<p class="stall">${model.gaps.length} idle gap${model.gaps.length === 1 ? '' : 's'} — longest ${escapeHtml(formatStepDuration(Math.max(...model.gaps.map((g) => g.durationMs))))}.</p>`
    : '';
  const truncNote = model.truncatedSteps > 0
    ? `<p class="stall">Showing the first ${model.steps.length} steps; ${model.truncatedSteps} later step${model.truncatedSteps === 1 ? '' : 's'} collapsed.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} — trajectory</title>
<style>${BASE_STYLE}</style>
</head>
<body>
<header>
  <div class="inner">
    <button class="toggle" id="theme" title="Toggle light and dark">&#9689;</button>
    <div class="mark">agents session trace</div>
    <h1>${escapeHtml(title)}${model2 ? ` <span class="muted">${model2}</span>` : ''}</h1>
    <div class="metrics">${metricLine}</div>
    <div class="chips">
      ${chips.join('\n      ')}
    </div>
  </div>
</header>
<main>
  <h2>Trajectory</h2>
  ${gapNote}
  ${truncNote}
  ${renderWaterfallSvg(model)}
  <h2>Where the time went</h2>
  ${renderTimeShare(model)}
  <h2>Steps</h2>
  <div class="steps">
    ${renderStepDetail(model)}
  </div>
</main>
<footer>
  ${model.truncatedSteps > 0 ? 'Truncated · ' : ''}Secret-redacted trajectory rendered by agents-cli &middot; <code>agents sessions trace</code>
</footer>
<script>${THEME_SCRIPT}</script>
</body>
</html>
`;
}

const BASE_STYLE = `
  :root {
    --bg: #0a0a0a; --panel: #121212; --border: #262626; --fg: #e5e5e5;
    --dim: #737373; --accent: #a3e635; --quote: #1a1a1a;
  }
  html[data-theme="light"] {
    --bg: #fafafa; --panel: #ffffff; --border: #e5e5e5; --fg: #171717;
    --dim: #737373; --accent: #4d7c0f; --quote: #f5f5f5;
  }
  @media (prefers-color-scheme: light) {
    html[data-theme="auto"] {
      --bg: #fafafa; --panel: #ffffff; --border: #e5e5e5; --fg: #171717;
      --dim: #737373; --accent: #4d7c0f; --quote: #f5f5f5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  header { border-bottom: 1px solid var(--border); padding: 24px 20px 18px; }
  header .inner, main { max-width: 960px; margin: 0 auto; }
  header .mark {
    color: var(--accent); font-weight: 700; letter-spacing: .5px; font-size: 12px;
    text-transform: uppercase; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
  header h1 { font-size: 20px; line-height: 1.3; margin: 8px 0 8px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
  .metrics { color: var(--dim); font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 13px; margin-bottom: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 11px;
    color: var(--fg); background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 2px 9px;
  }
  .chip .k { color: var(--dim); margin-right: 6px; }
  .toggle {
    float: right; cursor: pointer; background: none; border: 1px solid var(--border);
    color: var(--dim); border-radius: 6px; padding: 2px 8px; font-size: 14px;
  }
  main { padding: 20px 20px 64px; }
  h2 {
    font-size: 12px; color: var(--accent); border-bottom: 1px solid var(--border);
    padding-bottom: 6px; margin: 32px 0 14px; text-transform: uppercase;
    letter-spacing: 1px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
  .stall { color: #e0b341; font-size: 12.5px; margin: 6px 0; }
  .muted { color: var(--dim); }
  svg text { font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
  svg .axis { stroke: var(--border); stroke-width: 1; }
  svg .tick { fill: var(--dim); font-size: 8px; }
  svg .lane { fill: var(--dim); font-size: 9px; }
  svg .bar-label { fill: var(--dim); font-size: 8.5px; }
  svg .bar-dur { fill: var(--fg); }
  svg .gap { fill: #7a3030; fill-opacity: 0.12; }
  svg .gap-label { fill: #c06a6a; font-size: 8px; }
  svg a { cursor: pointer; }
  .share-row { display: flex; align-items: center; gap: 10px; margin: 5px 0; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12px; }
  .share-name { width: 120px; color: var(--fg); }
  .share-bar { flex: 1; height: 9px; background: var(--panel); border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
  .share-fill { display: block; height: 100%; }
  .share-pct { width: 44px; text-align: right; color: var(--dim); }
  .steps { display: flex; flex-direction: column; gap: 4px; }
  .step { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; background: var(--panel); scroll-margin-top: 16px; }
  .step:target { border-color: var(--accent); }
  .step-head { display: flex; align-items: center; gap: 8px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12px; flex-wrap: wrap; }
  .dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  .step-ord { color: var(--dim); width: 28px; }
  .step-tool { color: var(--fg); font-weight: 600; }
  .step-dur { color: var(--dim); }
  .outcome { font-size: 11px; padding: 0 6px; border-radius: 8px; }
  .outcome.ok { color: #7ee787; }
  .outcome.error { color: #f87171; }
  .est { color: #e0b341; font-size: 11px; }
  .tag { color: #b98cff; font-size: 11px; }
  .step-label { margin-top: 4px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12px; color: var(--fg); word-break: break-word; }
  pre.detail {
    margin: 6px 0 0; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; overflow-x: auto; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 11.5px; color: var(--dim); white-space: pre-wrap; word-break: break-word;
  }
  footer {
    max-width: 960px; margin: 0 auto; padding: 0 20px 48px;
    color: var(--dim); font-size: 12px;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
`;

/** Compare-only rules layered on top of {@link BASE_STYLE} — lanes, divergence marker, summary table. */
const COMPARE_STYLE = `
  svg .diverge { stroke: #e0b341; stroke-width: 1.4; stroke-dasharray: 4 3; }
  .diverge-note { color: #e0b341; font-size: 12.5px; margin: 6px 0; }
  table.cmp-table { border-collapse: collapse; width: 100%; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12.5px; }
  table.cmp-table th, table.cmp-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  table.cmp-table th { color: var(--dim); font-weight: 600; text-transform: uppercase; font-size: 10.5px; letter-spacing: .5px; }
  .diff-cols { display: flex; gap: 24px; flex-wrap: wrap; }
  .diff-col { flex: 1; min-width: 260px; }
  .diff-col h3 { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; margin: 0 0 8px; }
  .diff-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .diff-list li {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12px;
    border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; background: var(--panel);
  }
`;

const THEME_SCRIPT = `
  (function () {
    var root = document.documentElement;
    var saved = null;
    try { saved = localStorage.getItem('agents-share-theme'); } catch (e) {}
    if (saved) root.setAttribute('data-theme', saved);
    var toggle = document.getElementById('theme');
    if (toggle) toggle.addEventListener('click', function () {
      var dark = getComputedStyle(root).getPropertyValue('--bg').trim() === '#0a0a0a';
      var next = dark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('agents-share-theme', next); } catch (e) {}
    });
  })();
`;

function compareTitle(cmp: TrajectoryComparison): string {
  const a = cmp.a.session;
  const b = cmp.b.session;
  return `${a.agent} ${a.shortId || a.id} vs ${b.agent} ${b.shortId || b.id}`;
}

function renderCompareWaterfallSvg(cmp: TrajectoryComparison): string {
  const { a, b, divergence } = cmp;
  const sharedSpan = Math.max(a.spanMs, b.spanMs, 1);
  const rowH = 26;
  const top = 34;
  const width = GEO.labelW + GEO.chartW + 40;
  const height = top + 2 * rowH + 16;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Compare waterfall: two sessions' tool calls on a shared time axis with a divergence marker" xmlns="http://www.w3.org/2000/svg">`);

  const axisY = top - 10;
  parts.push(`<line x1="${GEO.labelW}" y1="${axisY}" x2="${GEO.labelW + GEO.chartW}" y2="${axisY}" class="axis" />`);
  for (const tick of axisTicks(sharedSpan)) {
    const x = GEO.labelW + tick.frac * GEO.chartW;
    parts.push(`<text x="${x.toFixed(1)}" y="${axisY - 3}" class="tick">${escapeHtml(tick.label)}</text>`);
  }

  const lanes = [
    { session: a.session, steps: a.steps.filter((s) => s.kind === 'tool') },
    { session: b.session, steps: b.steps.filter((s) => s.kind === 'tool') },
  ];
  lanes.forEach((lane, li) => {
    const y = top + li * rowH;
    const barY = y + 5;
    const barH = rowH - 12;
    const label = `${lane.session.agent} ${lane.session.shortId || lane.session.id}`;
    parts.push(`<text x="${GEO.labelW - 6}" y="${y + rowH / 2 + 3}" class="lane" text-anchor="end">${escapeHtml(label)}</text>`);
    for (const step of lane.steps) {
      const x = GEO.labelW + Math.min(1, Math.max(0, step.startMs / sharedSpan)) * GEO.chartW;
      const w = Math.max(3, (step.durationMs / sharedSpan) * GEO.chartW);
      const color = toolColor(step);
      const dur = formatStepDuration(step.durationMs);
      parts.push(`<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barH}" rx="2" fill="${color}"><title>${escapeHtml(label)} · step ${step.ordinal} · ${escapeHtml(step.tool ?? step.kind)} · ${escapeHtml(dur)}${step.outcome === 'error' ? ' ✗' : ''}</title></rect>`);
    }
  });

  if (divergence) {
    const dxA = GEO.labelW + Math.min(1, Math.max(0, divergence.startMsA / sharedSpan)) * GEO.chartW;
    const dxB = GEO.labelW + Math.min(1, Math.max(0, divergence.startMsB / sharedSpan)) * GEO.chartW;
    const dx = Math.min(dxA, dxB);
    parts.push(`<line x1="${dx.toFixed(1)}" y1="${top - 6}" x2="${dx.toFixed(1)}" y2="${top + 2 * rowH}" class="diverge"><title>diverge: ${escapeHtml(divergence.detail)}</title></line>`);
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function renderCompareSummaryTable(cmp: TrajectoryComparison): string {
  const rows = [cmp.summaryA, cmp.summaryB].map((s) => {
    const label = `${s.session.agent} ${s.session.shortId || s.session.id}`;
    return `<tr><td>${escapeHtml(label)}</td><td>${s.toolCount}</td><td>${s.errorCount}</td><td>${escapeHtml(formatDuration(s.spanMs))}</td><td>${escapeHtml(formatTokenCount(s.outputTokens))}</td></tr>`;
  }).join('\n');
  return `<table class="cmp-table"><thead><tr><th>session</th><th>tools</th><th>errors</th><th>duration</th><th>tokens</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderStepListItem(step: TrajectoryStep): string {
  const dur = formatStepDuration(step.durationMs);
  return `<li>${escapeHtml(step.tool ?? step.kind)} · ${escapeHtml(clipLabel(step.label))} <span class="muted">${escapeHtml(dur)}</span></li>`;
}

function renderCompareDiffLists(cmp: TrajectoryComparison): string {
  const aLabel = `${cmp.a.session.agent} ${cmp.a.session.shortId || cmp.a.session.id}`;
  const bLabel = `${cmp.b.session.agent} ${cmp.b.session.shortId || cmp.b.session.id}`;
  const removedItems = cmp.removed.length > 0
    ? cmp.removed.map(renderStepListItem).join('\n')
    : '<li class="muted">none</li>';
  const addedItems = cmp.added.length > 0
    ? cmp.added.map(renderStepListItem).join('\n')
    : '<li class="muted">none</li>';
  return `<div class="diff-cols">
    <div class="diff-col">
      <h3>Only in ${escapeHtml(aLabel)} (${cmp.removed.length})</h3>
      <ul class="diff-list">${removedItems}</ul>
    </div>
    <div class="diff-col">
      <h3>Only in ${escapeHtml(bLabel)} (${cmp.added.length})</h3>
      <ul class="diff-list">${addedItems}</ul>
    </div>
  </div>`;
}

/** Render a two-session {@link TrajectoryComparison} as a self-contained HTML page. */
export function renderTrajectoryCompareHtml(cmp: TrajectoryComparison): string {
  const title = compareTitle(cmp);
  const divergenceNote = cmp.divergence
    ? `<p class="diverge-note">◆ diverge after step ${cmp.divergence.afterOrdinalA}/${cmp.divergence.afterOrdinalB} — ${escapeHtml(cmp.divergence.detail)}</p>`
    : '<p class="muted">No divergence — the two tool sequences match.</p>';
  const truncNote = (cmp.truncatedA > 0 || cmp.truncatedB > 0)
    ? `<p class="stall">Diff capped — ${cmp.truncatedA} step${cmp.truncatedA === 1 ? '' : 's'} from the first and ${cmp.truncatedB} from the second were not compared.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} — compare</title>
<style>${BASE_STYLE}${COMPARE_STYLE}</style>
</head>
<body>
<header>
  <div class="inner">
    <button class="toggle" id="theme" title="Toggle light and dark">&#9689;</button>
    <div class="mark">agents session trace · compare</div>
    <h1>${escapeHtml(title)}</h1>
  </div>
</header>
<main>
  <h2>Trajectory</h2>
  ${truncNote}
  ${renderCompareWaterfallSvg(cmp)}
  ${divergenceNote}
  <h2>Summary</h2>
  ${renderCompareSummaryTable(cmp)}
  <h2>Step diff</h2>
  ${renderCompareDiffLists(cmp)}
</main>
<footer>
  Secret-redacted compare rendered by agents-cli &middot; <code>agents sessions trace</code>
</footer>
<script>${THEME_SCRIPT}</script>
</body>
</html>
`;
}

/** Lineage-only rules layered on top of {@link BASE_STYLE} — the node graph and its cards. */
const LINEAGE_STYLE = `
  .lineage-wrap { overflow-x: auto; }
  svg .lnode { cursor: pointer; }
  svg .lnode rect { fill: var(--panel); stroke-width: 1.3; }
  svg .lnode.selected rect { stroke-width: 2.4; }
  svg .lnode .n-id { font-size: 11px; }
  svg .lnode .n-sub { fill: var(--dim); font-size: 9px; }
  svg .ledge { stroke: #4a6b3a; stroke-width: 1.4; fill: none; }
  .lcards { margin-top: 4px; }
  .lcard { display: none; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; background: var(--panel); }
  .lcard.shown { display: block; }
  .lcard h3 { margin: 0 0 8px; font-size: 13px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
  .lcard dl { display: grid; grid-template-columns: 110px 1fr; gap: 3px 12px; margin: 0; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12px; }
  .lcard dt { color: var(--dim); }
  .lcard dd { margin: 0; word-break: break-word; }
  .legend { color: var(--dim); font-size: 11.5px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; margin: 8px 0 0; }
`;

/** Node stroke by recency — never a success/failure claim (see LineageActivity). */
function lineageColor(node: LineageNode): string {
  if (node.activity === 'active') return '#a3e635';
  if (node.activity === 'idle') return '#e0b341';
  return '#6e7681';
}

const LNODE = { w: 210, h: 68, gapX: 22, levelH: 124, top: 30, marginX: 20 };

/**
 * Characters that fit one node line at the given font size. The box is a fixed
 * 210px and the face is monospace (~0.6em per glyph), so a line longer than this
 * runs out past the border — clip it here rather than letting the SVG overflow.
 */
function fitNodeLine(text: string, fontSizePx: number): string {
  const max = Math.floor((LNODE.w - 24) / (fontSizePx * 0.62));
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Lay the graph out level by level: depth 0 on top, each level centered below it. */
function lineageLayout(lineage: SessionLineage): {
  width: number;
  height: number;
  at: Map<string, { x: number; y: number }>;
} {
  const levels = new Map<number, LineageNode[]>();
  for (const node of lineage.nodes) {
    (levels.get(node.depth) ?? levels.set(node.depth, []).get(node.depth)!).push(node);
  }
  const widest = Math.max(1, ...[...levels.values()].map((l) => l.length));
  const width = Math.max(920, LNODE.marginX * 2 + widest * LNODE.w + (widest - 1) * LNODE.gapX);
  const depth = Math.max(...lineage.nodes.map((n) => n.depth));
  const height = LNODE.top + (depth + 1) * LNODE.levelH;

  const at = new Map<string, { x: number; y: number }>();
  for (const [level, row] of levels) {
    const rowWidth = row.length * LNODE.w + (row.length - 1) * LNODE.gapX;
    const startX = (width - rowWidth) / 2;
    row.forEach((node, i) => {
      at.set(node.id, { x: startX + i * (LNODE.w + LNODE.gapX), y: LNODE.top + level * LNODE.levelH });
    });
  }
  return { width, height, at };
}

/** The inline-SVG delegation graph: one box per session, edges parent → child. */
function renderLineageSvg(lineage: SessionLineage): string {
  const { width, height, at } = lineageLayout(lineage);
  const byId = new Map(lineage.nodes.map((n) => [n.id, n]));
  const parts: string[] = [];

  parts.push('<defs><marker id="lg" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4a6b3a"/></marker></defs>');

  for (const edge of lineage.edges) {
    const from = at.get(edge.parent);
    const to = at.get(edge.child);
    if (!from || !to) continue;
    const x1 = from.x + LNODE.w / 2;
    const y1 = from.y + LNODE.h;
    const x2 = to.x + LNODE.w / 2;
    const y2 = to.y - 8;
    const mid = (y1 + y2) / 2;
    parts.push(`<path d="M${x1.toFixed(1)} ${y1} C ${x1.toFixed(1)} ${mid.toFixed(1)}, ${x2.toFixed(1)} ${mid.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" class="ledge" marker-end="url(#lg)"><title>${escapeHtml(edge.source)}</title></path>`);
  }

  for (const node of byId.values()) {
    const pos = at.get(node.id)!;
    const color = lineageColor(node);
    const name = node.handle && node.handle !== node.shortId ? `${node.handle} · ${node.shortId}` : node.shortId;
    // Three lines, because one 210px row cannot hold a handle, an id, a harness,
    // a role, a PR, and the counts without clipping the end off every node.
    const who = [node.agent, node.role];
    if (node.prNumber) who.push(`PR #${node.prNumber}`);
    const counts = [`${node.toolCount} tools`];
    if (node.durationMs > 0) counts.push(formatDuration(node.durationMs));
    counts.push(node.activity);
    parts.push(
      `<g class="lnode" data-id="${escapeHtml(node.id)}" tabindex="0">` +
      `<rect x="${pos.x.toFixed(1)}" y="${pos.y}" width="${LNODE.w}" height="${LNODE.h}" rx="8" stroke="${color}"><title>${escapeHtml(`${name} · ${who.join(' · ')} · ${counts.join(' · ')}`)}</title></rect>` +
      `<text x="${(pos.x + 12).toFixed(1)}" y="${pos.y + 22}" class="n-id" fill="${color}">${escapeHtml(fitNodeLine(name, 11))}</text>` +
      `<text x="${(pos.x + 12).toFixed(1)}" y="${pos.y + 40}" class="n-sub">${escapeHtml(fitNodeLine(who.join(' · '), 9))}</text>` +
      `<text x="${(pos.x + 12).toFixed(1)}" y="${pos.y + 56}" class="n-sub">${escapeHtml(fitNodeLine(counts.join(' · '), 9))}</text>` +
      '</g>',
    );
  }

  // Scale to the container and no further: a wide fan-out shrinks to fit rather
  // than pushing the page into a horizontal scroll, and a narrow one is not blown up.
  return `<div class="lineage-wrap"><svg viewBox="0 0 ${width} ${height}" style="width:100%;max-width:${width}px;height:auto" role="img" aria-label="Session lineage graph">${parts.join('')}</svg></div>`;
}

/** One detail card per node, revealed by clicking that node. */
function renderLineageCards(lineage: SessionLineage): string {
  return lineage.nodes
    .map((node) => {
      const s = node.session;
      const rows: Array<[string, string]> = [
        ['session', node.id],
        ['agent', node.agent],
        ['role', node.role],
        ['tools', String(node.toolCount)],
      ];
      if (node.durationMs > 0) rows.push(['span', formatDuration(node.durationMs)]);
      rows.push(['activity', node.activity]);
      if (node.team) rows.push(['team', node.team]);
      if (node.mode) rows.push(['mode', node.mode]);
      if (node.prNumber) rows.push(['pr', `#${node.prNumber}`]);
      if (s.project) rows.push(['project', s.project]);
      if (s.gitBranch) rows.push(['branch', s.gitBranch]);
      if (s.ticketId) rows.push(['ticket', s.ticketId]);
      if (s.outputTokens) rows.push(['out tokens', formatTokenCount(s.outputTokens)]);
      const date = (s.timestamp || '').slice(0, 10);
      if (date) rows.push(['started', date]);
      const dl = rows
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
        .join('\n        ');
      const heading = node.handle && node.handle !== node.shortId ? `${node.handle} · ${node.shortId}` : node.shortId;
      return `<div class="lcard${node.depth === 0 ? ' shown' : ''}" id="lcard-${escapeHtml(node.id)}">
      <h3>${escapeHtml(heading)}</h3>
      <dl>
        ${dl}
      </dl>
      <p class="muted" style="margin:8px 0 0;font-size:11.5px">Full trajectory: <code>agents sessions trace ${escapeHtml(node.shortId)}</code></p>
    </div>`;
    })
    .join('\n    ');
}

/** Wire node clicks to their cards. Self-contained, no CDN, no framework. */
const LINEAGE_SCRIPT = `
  (function () {
    var nodes = document.querySelectorAll('.lnode');
    function select(id) {
      document.querySelectorAll('.lcard').forEach(function (c) { c.classList.remove('shown'); });
      var card = document.getElementById('lcard-' + id);
      if (card) card.classList.add('shown');
      nodes.forEach(function (n) { n.classList.toggle('selected', n.getAttribute('data-id') === id); });
    }
    nodes.forEach(function (n) {
      var id = n.getAttribute('data-id');
      n.addEventListener('click', function () { select(id); });
      n.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); } });
    });
    if (nodes.length) select(nodes[0].getAttribute('data-id'));
  })();
`;

/**
 * Render a {@link SessionLineage} as ONE self-contained HTML page: the inline-SVG
 * delegation graph (orchestrator on top, the sessions it spawned below, edges
 * auto-discovered from the team records) plus a per-node summary card revealed
 * by clicking a node. Same shell, redaction, and no-CDN rule as the other two
 * layouts; local paths (`filePath`/`cwd`) are deliberately never rendered.
 */
export function renderLineageHtml(lineage: SessionLineage): string {
  const root = lineage.nodes[0];
  const title = root ? `${root.agent} · ${root.shortId}` : 'lineage';
  const spawned = Math.max(0, lineage.nodes.length - 1);
  const teamPart = lineage.teams.length > 0 ? ` · team ${lineage.teams.join(', ')}` : '';
  const empty = !root
    ? '<p class="muted">No lineage — the selected session spawned nothing that is indexed.</p>'
    : spawned === 0
      ? '<p class="muted">This session spawned no indexed teammate. Only the orchestrator is drawn.</p>'
      : '';
  const unresolved = lineage.unresolvedParentIds.length > 0
    ? `<p class="stall">${lineage.unresolvedParentIds.length} parent session${lineage.unresolvedParentIds.length === 1 ? '' : 's'} referenced but not in the scanned pool — widen with --all or --since.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} — lineage</title>
<style>${BASE_STYLE}${LINEAGE_STYLE}</style>
</head>
<body>
<header>
  <div class="inner">
    <button class="toggle" id="theme" title="Toggle light and dark">&#9689;</button>
    <div class="mark">agents session trace · lineage</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="metrics">${escapeHtml(`${spawned} spawned session${spawned === 1 ? '' : 's'}${teamPart}`)}</div>
  </div>
</header>
<main>
  <h2>Lineage</h2>
  ${empty}
  ${unresolved}
  ${root ? renderLineageSvg(lineage) : ''}
  <p class="legend">node color = recency (lime active · amber idle · grey stale) · click a node for its summary · edges from teamOrigin.parentSessionId</p>
  <h2>Session</h2>
  <div class="lcards">
    ${root ? renderLineageCards(lineage) : ''}
  </div>
</main>
<footer>
  Secret-redacted lineage rendered by agents-cli &middot; <code>agents sessions trace --tree</code>
</footer>
<script>${THEME_SCRIPT}</script>
<script>${LINEAGE_SCRIPT}</script>
</body>
</html>
`;
}
