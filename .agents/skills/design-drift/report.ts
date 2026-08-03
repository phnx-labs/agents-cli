#!/usr/bin/env bun
// design-drift · Phase 4 — render the ranked report + drafted tickets.
//
// Input: the synthesized, ranked design-drift findings (JSON array) produced by
// the drift-lens subagent, plus the run's meta.json. Output: a Markdown report
// to stdout. The skill redirects it to .agents/reports/design-drift-<date>.md.
//
// Read-only: renders text, never touches source. Ticket bodies are emitted as
// copy-pasteable `linear` CLI blocks so the run works whether or not the
// linear.app secrets bundle is reachable from the run host.
//
// Usage: bun report.ts <findings.json> <meta.json>

import { readFileSync, existsSync } from "node:fs";

interface Surface {
  cmd?: string;
  file: string;
  line?: number;
  quote?: string;
}
interface Finding {
  rank?: number;
  category: "overlapping-primitives" | "non-reuse" | "consolidation" | string;
  severity: "blocker" | "should" | "nice" | string;
  title: string;
  surfaces?: Surface[];
  existing_primitive?: string;
  evidence?: string;
  consolidation_proposal?: string;
  confidence?: string;
}
interface Meta {
  run_ts: string;
  base: string;
  window_since: string;
  pr_count: number;
  file_count: number;
  repo: string;
}

const [, , findingsPath, metaPath] = process.argv;
if (!findingsPath || !metaPath || !existsSync(findingsPath) || !existsSync(metaPath)) {
  console.error("usage: report.ts <findings.json> <meta.json>");
  process.exit(1);
}

const findings: Finding[] = JSON.parse(readFileSync(findingsPath, "utf8"));
const meta: Meta = JSON.parse(readFileSync(metaPath, "utf8"));

const SEV_ORDER: Record<string, number> = { blocker: 0, should: 1, nice: 2 };
findings.sort((a, b) => {
  if (a.rank != null && b.rank != null && a.rank !== b.rank) return a.rank - b.rank;
  return (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
});

const today = meta.run_ts.slice(0, 10);
const sev = (s: string) => (s === "blocker" ? "HIGH" : s === "should" ? "MEDIUM" : "LOW");
const surfLine = (s: Surface) =>
  `  - \`${s.cmd ?? s.file}\` — \`${s.file}${s.line ? `:${s.line}` : ""}\``;

const out: string[] = [];
out.push(`# Design-drift review — ${today}`);
out.push("");
out.push(
  `Nightly scan for **design drift**: new primitives introduced where an existing ` +
    `one should have been reused/extended — overlapping surfaces that work but are ` +
    `messy and hard to improve. Read-only analysis; no code was changed. Each ` +
    `finding names the existing primitive that should have absorbed the new code ` +
    `and a concrete consolidation proposal. Muqsit decides per-issue whether to ` +
    `dispatch a fix — this routine does **not** auto-fix.`,
);
out.push("");
out.push(
  `- **Window:** merges since \`${meta.window_since}\` on \`origin/${meta.base}\`` +
    ` · **${meta.pr_count}** PRs · **${meta.file_count}** files changed`,
);
out.push(`- **Findings:** ${findings.length} (ranked, most consolidation value first)`);
out.push(`- **Engine:** reuses the \`quality\` skill's behavioral-signature + architecture passes`);
out.push("");

// Summary table.
out.push("| # | Severity | Finding | Existing primitive to reuse |");
out.push("|---|---|---|---|");
findings.forEach((f, i) => {
  const prim = (f.existing_primitive ?? "").split("\n")[0].slice(0, 70);
  out.push(`| ${i + 1} | ${sev(f.severity)} | ${f.title} | ${prim} |`);
});
out.push("");

// Detailed findings.
out.push("## Findings");
out.push("");
findings.forEach((f, i) => {
  out.push(`### ${i + 1}. ${f.title}`);
  out.push("");
  out.push(`**Severity:** ${sev(f.severity)} · **Type:** ${f.category}` +
    (f.confidence ? ` · **Confidence:** ${f.confidence}` : ""));
  out.push("");
  if (f.surfaces?.length) {
    out.push(`**Overlapping surfaces:**`);
    f.surfaces.forEach((s) => out.push(surfLine(s)));
    out.push("");
    for (const s of f.surfaces) {
      if (s.quote) {
        out.push("```ts");
        out.push(`// ${s.file}${s.line ? `:${s.line}` : ""}`);
        out.push(s.quote.trim());
        out.push("```");
      }
    }
    out.push("");
  }
  if (f.existing_primitive) {
    out.push(`**Reuse instead:** ${f.existing_primitive}`);
    out.push("");
  }
  if (f.evidence) {
    out.push(`**Why it's drift:** ${f.evidence}`);
    out.push("");
  }
  if (f.consolidation_proposal) {
    out.push(`**Consolidation proposal:** ${f.consolidation_proposal}`);
    out.push("");
  }
});

// Drafted tickets — copy-pasteable, so the run works with linear.app offline.
out.push("## Drafted Linear tickets");
out.push("");
out.push(
  `> The \`linear.app\` secrets bundle was not reachable from the run host, so ` +
    `tickets are **drafted** here rather than filed. Run these once the bundle is ` +
    `present (\`agents secrets exec linear.app -- ...\`), or file them from a box ` +
    `that has it. Tag: \`design-drift\`.`,
);
out.push("");
findings.forEach((f, i) => {
  const title = f.title.replace(/"/g, "'");
  const bodyParts: string[] = [];
  if (f.surfaces?.length)
    bodyParts.push(
      "Overlapping surfaces:\\n" +
        f.surfaces.map((s) => `- ${s.cmd ?? s.file} (${s.file}${s.line ? `:${s.line}` : ""})`).join("\\n"),
    );
  if (f.existing_primitive) bodyParts.push(`Reuse instead: ${f.existing_primitive}`);
  if (f.evidence) bodyParts.push(`Why it's drift: ${f.evidence}`);
  if (f.consolidation_proposal) bodyParts.push(`Proposal: ${f.consolidation_proposal}`);
  const body = bodyParts.join("\\n\\n").replace(/"/g, "'");
  out.push("```bash");
  out.push(
    `linear issue create --title "design-drift: ${title}" \\\n` +
      `  --label design-drift --description "${body}"`,
  );
  out.push("```");
  out.push("");
});

process.stdout.write(out.join("\n") + "\n");
