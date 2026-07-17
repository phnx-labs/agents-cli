---
name: cgraph
description: "Use FIRST for any question about THIS codebase's structure, symbols, or relationships — where a function/class/file is defined, what calls or imports it, what breaks if you change it, how two parts connect, or to load focused source context before editing or reviewing. Routes to the cgraph MCP tools (graph_query / graph_explain / graph_impact / graph_path / graph_context), which serve ranked file:line results, node neighborhoods, transitive blast radius, and token-budgeted source bundles from a resident per-project graph daemon in ~10ms — far cheaper than grepping and reading files. Prefer over blind grep/read for code navigation, dependency tracing, and impact analysis."
user-invocable: true
---

# cgraph

cgraph keeps a live, queryable graph of the current project — symbols (functions,
classes, types, files), their call/import/inheritance/containment edges, and
centrality ranking — served by a resident per-project daemon through MCP tools.

**Reach for these tools before grepping or reading files** when a question is
about code structure or relationships. A graph call is one ~10ms round-trip and
returns exactly the file:line (and often the source) you need, instead of many
grep/read calls that burn context.

## Setup (one-time — the tools don't exist until this is done)

This skill routes to the `cgraph` MCP server. On a cold checkout that server is
**not** registered — until it is, the `graph_*` tools below don't exist and you
should navigate with grep/read. Registration is a local, per-machine step (the
`.mcp.json` it writes is gitignored, not committed), so a fresh clone needs it.

1. **Build cgraph from source** — it's a native C++ engine (CMake + vcpkg,
   C++20; on Linux `igraph` also needs `gfortran`). Full instructions:
   <https://github.com/taylor009/CGraph> → *Install & Setup*. This produces
   `cgraph`, `graphd`, `cgraph-client`, and `cgraph-mcp`.
2. **Register the MCP server** (project-scoped, absolute binary paths):
   ```sh
   agents mcp add cgraph -s project -a claude,codex -- \
     /abs/path/to/cgraph-mcp --root "$(pwd)" --daemon /abs/path/to/graphd
   agents mcp register cgraph
   ```
3. Restart the agent session so it picks up the server. `graph_status` should
   then answer, and the first query triggers a one-time build (seconds).

If the `graph_*` tools return "no such tool", registration hasn't happened —
fall back to grep/read and (if you can) run the steps above.

## Routing: question → tool

| When the user / task needs… | Call |
| --- | --- |
| "Where is X? Find the symbol named …" | `graph_query` `{query}` — ranked by importance, each hit has `source_file` + `line` |
| "What is X? Show its callers/callees/imports" | `graph_explain` `{id}` — node + neighbors (each with `direction` and a navigable brief) + a source snippet |
| "What breaks if I change X? What depends on it?" | `graph_impact` `{id, direction:"dependents"}` — transitive blast radius, bounded by `max_depth` |
| "What does X rely on?" | `graph_impact` `{id, direction:"dependencies"}` |
| "How does A connect to B?" | `graph_path` `{source, target}` — shortest path, with `path_nodes` briefs |
| "Load context on X" / before editing or reviewing X | `graph_context` `{query or id, budget}` — focal node + most-relevant neighbors with snippets, packed to a token budget |
| "Verify the graph is current before I rely on it" | `graph_update {path:"."}` — blocking content-verified synchronization; returns `freshness.content_root`. Pin subsequent reads by passing the root as `expected_content_root`. |
| "Is the graph current? / I just changed files" | Nothing for ordinary reads — the daemon watches the tree and folds edits in within seconds. Use `graph_update` when you need a verified content_root to pin reads. |

## How to use the results

- `graph_query` matches case-insensitively and can be narrowed with `kind`
  (e.g. `"function"`, `"class"`, `"file"`), `file` (source-path substring), and
  `limit`. On zero matches it returns `suggestions` — the closest symbol names —
  so correct the spelling and retry instead of falling back to grep.
- Every id-taking tool (`graph_explain` / `graph_impact` / `graph_path` /
  `graph_context`) also accepts a bare symbol name (e.g. `"merge_fragments"`);
  the response echoes the canonical `id` it resolved. A miss comes back with
  `found: false` plus `suggestions`.
- `graph_query` returns ids and `source_file`:`line`. Open the file at `line`
  directly — no second search needed.
- `graph_explain` takes `direction` (`"in"` = callers/importers, `"out"` =
  callees/imports) and `limit`; neighbors are ordered most-important-first and
  `neighbor_count`/`truncated` flag when a hub has more edges than returned.
- `graph_context` is the highest-leverage call before an edit or review: ask for
  a budget (e.g. `4000`) and it returns the focal symbol's source plus its
  neighborhood's source, ranked and trimmed to fit. Read that instead of opening
  files one by one. It reports `omitted` / `truncated` if more existed.
- `graph_context` has two **gather** modes. The default (`gather:"fixed"`) packs
  the whole k-hop neighborhood. When you have a task in hand, pass
  `gather:"adaptive"` **together with a `query`** — it keeps the full 2-hop core
  but expands the third hop only along query-relevant nodes. On the retrieval
  eval that lifted grade-2 recall by **+0.057 for +13% candidate tokens**, versus
  the **+96%** a full 3-hop gather costs. The relevance gate is a no-op without a
  query, so never send `adaptive` without one. The response echoes
  `gather:"adaptive"`, `packing:"knapsack"`, and a `reach` summary
  (`{candidates, expanded_past_core, gated_at_core}` — `expanded_past_core: 0`
  means nothing relevant lay past the 2-hop core, so it collapsed to it). Raise
  or lower `gather_theta` to tighten or loosen the relevance threshold.
- `graph_impact` with `dependents` is the safety check before changing a
  signature or deleting a symbol: it lists everything that would be affected,
  by depth.

## Freshness-sensitive navigation

When a task must rely on the graph being current with the worktree — before impact
analysis of a symbol you just moved, or after a batch of file edits — use the
synchronize-then-pin pattern:

```
1. update = graph_update {path: "."}
2. root = update.freshness.content_root
3. graph_query / graph_explain / graph_impact / graph_path / graph_context
       {…, expected_content_root: root}
```

`graph_update` is a blocking content-verified barrier: it hashes every detected
code file and re-extracts any whose content changed. The returned
`freshness.content_root` uniquely identifies that source snapshot. The response
also reports `files_hashed` and `bytes_hashed`. Passing the root as
`expected_content_root` on a subsequent read pins the response to the same
snapshot; the daemon returns an
error instead of graph data if it has published a different root since then.

Ordinary reads (without `expected_content_root`) do not scan the filesystem. They
read the latest published snapshot and return its `freshness` metadata; during
startup or for non-source seam graphs, `freshness.verified` can be `false`. The
daemon keeps source-backed snapshots current through automatic file watching.
Use synchronization and a pin when you need proof that the graph matches specific
source content.

## Session memory (survive /compact and /clear)

The daemon and `graph.json` live **outside your context window**, so a checkpoint
written before a `/compact` or `/clear` is still recall-able afterward. Use this
to carry the task thread across a context reset instead of losing it.

- `graph_remember {title, body, touches?, tags?}` — write one checkpoint. `body`
  is a **distilled** markdown summary of what you did and what's next; `touches`
  lists the code symbols (ids or bare names) the work concerns, so recall can link
  back to them. Persist only the distilled outcome — **never** raw tool output,
  DOM snapshots, or chain-of-thought.
- `graph_recall {query?, limit?}` — return recent checkpoints newest-first, each
  with its body and briefs of the code it touched. After a `/clear`, recall first
  (~KB payload) to restore the thread, then `graph_context` on a linked symbol to
  reload just-enough source.

The discipline is **distill → checkpoint → clear → recall**. Checkpoints are
inert to code analysis (they never shift query/impact/context rankings) and
survive daemon restart, incremental edits, and full rescans — the sidecars under
`cgraph-out/memory/` are the durable source of truth.

## Practicalities

- The `cgraph` MCP server must be registered (it auto-spawns a per-project daemon
  keyed to the project root). The first tool call in a project triggers a
  one-time graph build (seconds), then queries are warm (~10ms).
- While that first build runs, results carry `"graph_state": "building"` — an
  empty result then means "not built yet", not "no match". Retry after a few
  seconds or poll `graph_status` until `build_state` is `"ready"`.
- The daemon watches the project tree (`graph_status` reports `watching`): file
  edits land in the graph automatically within a few seconds, and the graph is
  re-persisted in the background.
- Fall back to grep/read only when cgraph genuinely has no answer — e.g. a
  string literal, a comment, a config value, or a file type cgraph does not
  extract. For symbols and their relationships, prefer the graph.
- cgraph indexes code structure deterministically. Prose/doc relationships
  appear only if semantic enrichment fragments have been ingested; don't assume
  documentation concepts are present unless `graph_status` shows enrichment.
