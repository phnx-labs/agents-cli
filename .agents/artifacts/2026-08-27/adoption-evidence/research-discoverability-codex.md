# How AI assistants discover, recommend, and successfully use `agents-cli`

Research date: 2026-08-27. Scope: public specifications, official product documentation, registries, executable open-source auditors, and empirical studies. “Recommended” and “usable” are separate problems:

1. A model or answer engine must know that `agents-cli` exists.
2. It must associate it with relevant user intents.
3. The runtime must be able to discover and operate it correctly.

## Executive conclusion

For `@phnx-labs/agents-cli`, the strongest strategy is:

- Build broad, independently corroborated web presence around exact problem-language: “run coding agents in parallel,” “manage multiple Claude Code accounts,” and “pin/switch agent CLI versions.” LLM recommenders exhibit popularity and exposure bias, so repeated presence in repositories, package metadata, technical articles, comparisons, and community discussions matters more than a special metadata file ([Amazon Science popularity-bias study](https://assets.amazon.science/a7/b5/145fc4734ee6abc2af4ce3b05943/large-language-models-as-recommender-systems-a-study-of-popularity-bias.pdf), [EMNLP product-recommendation bias study](https://aclanthology.org/2025.emnlp-main.1140.pdf)).
- Make the npm and GitHub pages exceptionally explicit and crawlable. Vendor-owned documentation represented 21% of 184,212 observed ChatGPT citations in one 2026 dataset, although that commercial study is not specific to developer tools ([MaxAEO citation study](https://maxaeo.ai/blog/sources-chatgpt-cites/)).
- Publish an installable cross-harness skill and a Claude Code/Cursor plugin. These create deterministic discovery inside agent runtimes; they are much stronger than hoping a crawler notices `llms.txt` ([Claude marketplace docs](https://code.claude.com/docs/en/discover-plugins), [skills.sh](https://skills.sh/), [Cursor marketplace](https://cursor.com/marketplace)).
- Preserve and improve the existing CLI: workflow-first `--help`, `--json`, noninteractive operation, semantic errors, dry runs, and idempotent mutations. Current controlled research finds agent scaffolding matters more than whether the surface is MCP or CLI ([MCP-versus-CLI study](https://arxiv.org/abs/2608.08654)).
- Publish `llms.txt`, markdown mirrors, content negotiation, and crawler access because they are inexpensive retrieval improvements—but do not treat them as a recommendation-ranking mechanism. No major answer engine publicly confirms using third-party `llms.txt` as a ranking or citation signal, and 2026 server-log evidence shows negligible retrieval ([llms.txt proposal](https://llmstxt.org/), [137,210-domain log analysis](https://josephtimpson.com/insights/does-llms-txt-work), [provider-status review](https://llmtxt.info/does-chatgpt-use-llms-txt/)).

---

## 1. Agent-readable web standards

### `llms.txt` and `llms-full.txt`

The current proposal defines `/llms.txt` as a concise Markdown index containing an H1, optional blockquote and prose, followed by H2 sections of links. Its 2026 revision also recommends ordinary web discovery mechanisms such as `rel="alternate" type="text/markdown"` and `rel="describedby"` ([actual specification](https://llmstxt.org/)).

`llms-full.txt` is a community convention for consolidated content, not a required part of the original format; Vercel explicitly describes that distinction ([Vercel Academy](https://vercel.com/academy/agent-friendly-apis/add-llms-txt)).

Adoption is real at the publication layer: documentation platforms and AI vendors publish these files, and the proposal reports thousands of publishing sites ([llms.txt specification](https://llmstxt.org/)). Publication does not establish automatic consumption.

Evidence against answer-engine impact is much stronger than evidence for it:

- No public OpenAI, Anthropic, Google, or Perplexity documentation says that arbitrary third-party `llms.txt` files are used as recommendation or citation signals ([provider documentation review](https://llmtxt.info/does-chatgpt-use-llms-txt/)).
- A May 2026 analysis covering 137,210 domains reported only 233 requests from AI-retrieval bots versus 6,847 from audit tools—auditors fetched the files 29 times more often ([log analysis](https://josephtimpson.com/insights/does-llms-txt-work)).
- The proposal’s strongest confirmed use remains explicit developer tooling and manually configured retrieval, not generic ChatGPT/Perplexity discovery ([llms.txt integrations](https://llmstxt.org/)).

**Verdict:** useful low-cost retrieval infrastructure; **cargo cult when sold as an AEO ranking lever**.

For `agents-cli`, publish:

- `/llms.txt`: short intent-oriented index.
- `/llms-full.txt`: complete installation, account management, version pinning, teams, sessions, devices, and examples.
- Markdown mirrors for every documentation page.
- `Accept: text/markdown` responses with `Vary: Accept`.
- Canonical and Markdown-alternate links.

These follow Vercel’s current retrieval guidance ([Vercel documentation guide](https://vercel.com/kb/guide/make-your-documentation-readable-by-ai-agents), [content-negotiation implementation](https://vercel.com/blog/making-agent-friendly-pages-with-content-negotiation)).

### `AGENTS.md`

`AGENTS.md` is materially different: coding harnesses directly inject it into the working context. The project reports adoption by more than 60,000 open-source repositories ([agents.md](https://agents.md/)).

Documented consumers include:

- OpenAI Codex: reads `AGENTS.override.md`/`AGENTS.md` from the Codex home and along the repository-to-working-directory path, subject to a default 32 KiB cap ([OpenAI’s Codex loop description](https://openai.com/index/unrolling-the-codex-agent-loop/), [implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs)).
- Cursor Agent and Cursor CLI: read root `AGENTS.md`; Cursor also supports `.cursor/rules` and `CLAUDE.md` ([Cursor rules](https://prod.cursor.com/docs/rules), [Cursor CLI](https://docs.cursor.com/en/cli/using)).
- The broader supported-harness list is maintained by the standard’s project, but each claimed consumer should be checked against its own current documentation before relying on nuanced behavior ([agents.md supported agents](https://agents.md/)).

Research tempers the “more instructions are always better” assumption. OpenAI reports that one large monolithic `AGENTS.md` consumed context, became stale, and was difficult to verify; its preferred pattern is a short map into maintained repository documentation ([OpenAI harness engineering](https://openai.com/index/harness-engineering/)). Academic evaluations likewise report mixed or negative results for generated context files and identify configuration smells ([AGENTS.md evaluation](https://arxiv.org/abs/2602.11988), [configuration-smells study](https://arxiv.org/abs/2606.15828)).

**Verdict:** direct, verified runtime consumption; high value inside the `agents-cli` repository. It does not make ChatGPT recommend the npm package to outsiders.

### MCP registries and submission mechanics

| Registry/catalog | Exact submission path | What listing actually buys |
|---|---|---|
| Official MCP Registry | Publish the npm artifact; add matching `mcpName` to `package.json`; generate `server.json` with `mcp-publisher init`; authenticate using `mcp-publisher login github`; run `mcp-publisher publish` ([official quickstart](https://modelcontextprotocol.io/registry/quickstart)). | Canonical metadata source for downstream subregistries; the MCP project explicitly expects marketplaces to ingest and enrich it ([registry announcement](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/)). |
| Smithery | For a remote server, visit `smithery.ai/new` or run `smithery mcp publish "https://…/mcp" -n @org/name`; Streamable HTTP and OAuth are required when authentication is needed ([publishing docs](https://smithery.ai/docs/build/publish)). | Dedicated searchable page, connection handling and usage analytics; users can discover and invoke servers through Smithery’s CLI and client integrations ([Smithery overview](https://smithery.ai/docs/build), [CLI](https://smithery.ai/docs/concepts/cli)). |
| MCP.so | Submit type, name, URL, and server configuration through its public form; submissions undergo admin review ([submission form](https://mcp.so/submit), [directory FAQ](https://mcp.so/servers/mcp-server-directory)). | Human-facing directory exposure. I found no published evidence that major answer engines use MCP.so as a ranking signal. |
| PulseMCP | Use the manual form at `pulsemcp.com/submit`; Pulse also ingests multiple data sources and exposes a Generic MCP Registry-compatible subregistry API ([Pulse API documentation](https://www.pulsemcp.com/api)). | Directory and API visibility. No controlled recommendation-impact evidence located. |
| Docker MCP Catalog | Add the server to `docker/mcp-registry` through a PR following that repository’s contribution rules; accepted servers appear within 24 hours in Docker Desktop, Docker Hub’s `mcp` namespace, and the catalog ([Docker catalog docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/)). | Strong operational distribution: Docker’s experimental Dynamic MCP gives agents `mcp-find` and `mcp-add`, allowing in-conversation catalog discovery ([Dynamic MCP](https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/)). |
| Cloudflare | Cloudflare publishes a catalog of its own managed servers; I found deployment documentation but no general third-party catalog-submission procedure ([Cloudflare catalog](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)). | Hosting on Cloudflare is not equivalent to being listed by Cloudflare. Do not claim catalog distribution without an accepted listing route. |

For a CLI whose core function is local orchestration, a full MCP wrapper should expose a small management surface, not mirror every CLI subcommand. A bloated MCP server creates schema and security overhead without proving greater adoption.

### Skills and plugin marketplaces

- Anthropic official marketplace: package skills, agents, hooks, MCP or LSP configuration as a plugin and submit through `claude.ai/settings/plugins/submit` or `platform.claude.com/plugins/submit` ([Claude plugin docs](https://code.claude.com/docs/en/discover-plugins)).
- Independent Claude marketplace: publish `.claude-plugin/marketplace.json`; users install it with `claude plugin marketplace add owner/repo` and then `claude plugin install plugin@marketplace`. Validate with `claude plugin validate .` ([marketplace specification](https://code.claude.com/docs/en/plugin-marketplaces)).
- Cursor: package rules, skills and MCP integration as a Cursor plugin; the public marketplace is now the relevant distribution surface ([Cursor marketplace](https://cursor.com/marketplace)). Repository-local rules live in `.cursor/rules/*.mdc`; users can create one with `/create-rule` or Customize → Rules ([Cursor rules](https://prod.cursor.com/docs/rules)).
- Skills ecosystem: place one or more valid `SKILL.md` directories in a public repository; users install from GitHub with `npx skills add owner/repo`, and discover indexed skills through skills.sh ([skills.sh](https://skills.sh/), [registry documentation](https://www.gotskills.sh/docs)).
- Awesome Claude Code lists: contribution usually means adding the repository in the requested format and opening a PR; one current list requires direct relevance, active maintenance, the appropriate category and a brief justification ([example contribution rules](https://github.com/itgoyo/awesome-claude-code)).
- AI-rules registries: `guidelines.directory` accepts additions by forking its GitHub repository, adding metadata, and opening a PR ([submission instructions](https://guidelines.directory/about)).

**Practical packaging:** ship one authoritative `agents-cli` skill whose description contains the exact triggering intents, then compile or package it for Claude, Cursor, Codex and Gemini. Marketplace presence gives installed runtimes a deterministic description they can match; it does not retroactively alter base-model knowledge.

### `/.well-known/`, agent cards, x402, and successor formats

These standards solve different problems and should not be conflated:

- A2A’s standardized discovery document is `/.well-known/agent-card.json`. Its `AgentCard` declares identity, capabilities, skills, protocols and authentication; A2A servers must expose a card, with well-known URL, registry and direct configuration as recognized discovery strategies ([A2A specification](https://a2a-protocol.org/dev/specification/), [discovery guide](https://a2a-protocol.org/latest/topics/agent-discovery/)).
- The MCP Server Card work is still experimental. Its current extension repository explicitly says it has not been accepted into the main specification and recommends `<streamable-http-endpoint>/server-card`, not a generic `agent.json` ([experimental MCP Server Card](https://github.com/modelcontextprotocol/experimental-ext-server-card)).
- `/agents.txt` and `/agents.json` are a separate community proposal for advertising protocols, payments, MCP endpoints, skills and A2A cards. They are not IETF standards and no major answer-engine consumption evidence was found ([proposal](https://github.com/agents-txt/agents-txt)).
- x402 is a payment protocol, not a general discovery or recommendation standard. Version 2 supports HTTP, MCP and A2A transports and a Bazaar extension for facilitator-based resource discovery ([x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md), [MCP/Bazaar integration](https://github.com/x402-foundation/x402/blob/main/docs/guides/mcp-server-with-x402.md)).
- A proposed `/.well-known/x402-discovery` remains a GitHub proposal, not the official discovery path ([proposal issue](https://github.com/x402-foundation/x402/issues/1348)).
- RFC 9727’s `/.well-known/api-catalog` is relevant for API discovery, but it does not make a local npm CLI discoverable to ChatGPT by itself ([RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html)).

**Cargo-cult warning:** publishing `agent.json`, `/agents.txt`, every experimental server card, and x402 metadata without offering a remotely callable service creates files for scanners, not user value.

---

## 2. Vercel guidance and the “Marcel” post

### The specific Vercel guidance

Vercel’s current guidance has three layers:

1. **Discovery:** `/llms.txt`, accurate `sitemap.xml`, semantic `sitemap.md`, explicit `robots.txt`, and page-level structured data.
2. **Retrieval:** Markdown content negotiation, `.md` endpoints, frontmatter, canonical metadata, and Markdown alternate links.
3. **Tool access:** MCP/search API plus `SKILL.md` or `AGENTS.md`.

That is Vercel’s actual published model, not an inference ([documentation guide](https://vercel.com/kb/guide/make-your-documentation-readable-by-ai-agents)).

The requested checklist cannot be reproduced wholesale verbatim here, but its compact core wording is:

> “Discoverable content … Clean retrieval … Structured metadata … Tool access”

Source: [Vercel’s documentation guide](https://vercel.com/kb/guide/make-your-documentation-readable-by-ai-agents).

A faithful, complete paraphrase of the checklist is:

- Serve a curated root content index.
- Publish current XML and Markdown sitemaps.
- State crawler access policy.
- Add page-level structured data.
- Return Markdown when requested and correctly vary caches by `Accept`.
- Offer Markdown URLs with title, canonical URL, and modification date.
- Advertise Markdown alternatives from HTML.
- Give agents a search/API protocol and an install/config/usage skill file.

Vercel’s February implementation article shows the concrete mechanism: detect `Accept: text/markdown`, rewrite to a Markdown route, preserve headings/code/links, return `Content-Type: text/markdown`, and advertise the representation with `rel="alternate"` ([content-negotiation article](https://vercel.com/blog/making-agent-friendly-pages-with-content-negotiation)).

Vercel’s broader “Agent Readability” rubric additionally checks response status and redirects, MIME types, robots directives, canonical tags, descriptions, Open Graph fields, language, JSON-LD, heading structure, text density, fenced code and OpenAPI links ([full rubric](https://vercel.com/kb/guide/agent-readability-spec)).

### Robots and AI crawlers

Vercel recommends an explicit robots policy covering `GPTBot`, `ClaudeBot`, `CCBot`, and `Google-Extended` ([Vercel rubric](https://vercel.com/kb/guide/agent-readability-spec)). These identities are not interchangeable:

- OpenAI documents distinct bots for training, search and user-triggered retrieval, each controllable through `robots.txt` ([OpenAI crawler docs](https://developers.openai.com/api/docs/bots)).
- Anthropic likewise distinguishes ClaudeBot and user-triggered fetchers ([Anthropic crawler documentation](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)).
- Perplexity documents PerplexityBot and Perplexity-User separately ([Perplexity crawler docs](https://docs.perplexity.ai/guides/bots)).

Allowing the appropriate search/user crawler is a necessary access condition, not proof of recommendation ranking.

### The “Marcel” item

I searched combinations involving Marcel Pociot, Beyond Code, Vercel, “agent-friendly,” “AI-ready,” “agents,” and `llms.txt`. I did not locate a verifiable 2026 Marcel-authored post matching the requested description.

The likely conflation is with:

- Vercel’s February 2026 article by Zach Cowan and Mitul Shah ([article](https://vercel.com/blog/making-agent-friendly-pages-with-content-negotiation)).
- Vercel’s March 2026 specification by Timothy Jordan ([specification](https://vercel.com/kb/guide/agent-readability-spec)).
- Vercel’s June guide by Rich Haines and Timothy Jordan ([guide](https://vercel.com/kb/guide/make-your-documentation-readable-by-ai-agents)).

I would not attribute this checklist to Marcel without a URL.

---

## 3. Open-source agent-friendliness auditors

“Every” cannot be guaranteed across all of GitHub, but these are the publicly discoverable, runnable open-source tools I could verify. Ranking is for a CLI/npm repository.

| Rank | Tool | Run command | Best use | Limitation |
|---:|---|---|---|---|
| 1 | Agentlint | `npx -y @agentlinthq/cli@latest .` | Broad repository readiness across Claude, Cursor, Codex, Copilot and Gemini; checks instruction files and project setup ([repository](https://github.com/agentlint/agentlint)). | Rubric-driven; a high score does not prove task success. |
| 2 | `agnix` | `npx agnix .` | Cross-harness config linting, including AGENTS, Cursor, Copilot, Codex, Gemini and MCP assets ([project announcement/source](https://github.com/avifenesh/agnix)). | Configuration correctness, not recommendation visibility. |
| 3 | `agents-lint` | `npx agents-lint` | Finds stale paths, invalid npm scripts and context rot in agent instruction files ([repository](https://github.com/giacomo/agents-lint)). | Some advertised features remain roadmap items. |
| 4 | MCP Inspector | `npx @modelcontextprotocol/inspector <server-command>` | Official interactive/CLI protocol inspection for any MCP wrapper ([official repository](https://github.com/modelcontextprotocol/inspector), [2026 CLI docs](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tools/inspector/cli.mdx)). | Protocol behavior, not security certification or discovery. |
| 5 | Red Hat MCP validation | Clone, then run `mcp-validate --repo-url <repo> -- <server-command>` | Protocol, repository and security-oriented MCP validation with JSON reports ([repository](https://github.com/RHEcosystemAppEng/mcp-validation)). | No simple verified `npx` launcher. |
| 6 | IsReadyAI | `npx isreadyai https://example.com --deep --md` | Crawlability and browser-agent readability; explicitly gives `llms.txt` zero ranking weight ([repository](https://github.com/isreadyai/isreadyai)). | Website-oriented, not CLI semantics. |
| 7 | Agent Lighthouse | `npx @agentlighthouse/cli scan .` | Scans repository, docs and API surfaces; emits CI/SARIF-style results ([repository](https://github.com/PainDeMie64/agentlighthouse)). | Young project; independently validate its scoring assumptions. |
| 8 | `agent-readiness` | Run from the project described at `itaides/agent-readiness` | Localhost/VPN-friendly implementation of common site-readiness checks ([repository](https://github.com/itaides/agent-readiness)). | Site-oriented and newer. |
| 9 | `llms-txt-validator` | `npx llms-txt-validator https://example.com` | File, link, sitemap, robots and crawler-access validation; explicitly promises no rankings ([repository](https://github.com/maxaeo/llms-txt-validator)). | Validates a weakly consumed convention. |
| 10 | BridgeToAgent validator | `npx @bridgetoagent-com/llms-txt-validator ./public/llms.txt --check-links` | Strict format and reachability checks ([repository](https://github.com/bridgetoagent/llms-txt-validator)). | Does not evaluate whether any engine consumes it. |
| 11 | DualNova `llms-txt` | `npx @dualnova/llms-txt validate --url https://example.com/llms.txt` | Zero-dependency parsing and validation ([repository](https://github.com/DualNova/llms-txt)). | Same limited scope. |
| 12 | `aeo-platform` | `npx aeo-platform@latest init … && npx aeo-platform@latest run && npx aeo-platform@latest report` | Measures responses across multiple model APIs and audits crawler/authority signals ([repository](https://github.com/webappski/aeo-platform)). | Requires API keys; API behavior may differ from consumer UIs. |
| 13 | `geo-audit` | Clone, run `bash scripts/install.sh`, then `.venv/bin/geo-audit audit <url> -o report/` | Modular GEO/site audit with local reports ([repository](https://github.com/g-shevchenko/geo-audit)). | Marketing-site focus and heuristic scoring. |
| 14 | `aiseo` | Clone and `cargo install --path .`, then `aiseo audit page.html` | JSON/SARIF agent-oriented page audit ([repository](https://github.com/paperfoot/aiseo)). | Not published as a verified `npx` package. |
| 15 | HERALD | Use the repository CLI to generate and validate discovery files | Emits `robots.txt`, `llms.txt`, agents files, API catalog, cards and skills discovery ([repository](https://github.com/agents-txt/herald)). | Generates multiple experimental surfaces; passing validators does not establish adoption. |

For `agents-cli`, run the first five against the repository/MCP surface and use one—not five—website scanners. Multiple validators of the same `llms.txt` syntax add little value.

Cloudflare’s `isitagentready.com` is relevant but is a hosted audit service rather than a clearly documented open-source CLI ([Cloudflare announcement](https://blog.cloudflare.com/agent-readiness/)).

---

## 4. Answer-engine optimization for developer tools

### What is actually supported by evidence

#### Repetition and popularity matter

LLM recommendation systems inherit popularity bias from training and recommendation data, favoring heavily represented items ([Amazon Science study](https://assets.amazon.science/a7/b5/145fc4734ee6abc2af4ce3b05943/large-language-models-as-recommender-systems-a-study-of-popularity-bias.pdf), [popularity-bias survey](https://link.springer.com/article/10.1007/s11257-024-09406-0)).

For `agents-cli`, GitHub stars and npm downloads should therefore be treated as useful social and corpus-presence proxies—but I found no controlled study showing that increasing either metric by a fixed amount causes ChatGPT to recommend a developer tool more often.

#### Retrieval rankings and source choice vary by engine

Search-augmented models exhibit different source preferences; Berkeley’s Search Arena work found, for example, different tendencies toward Wikipedia, social/community platforms and video sources ([Search Arena report](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/Archive/EECS-2025-177.pdf)).

Large observational datasets also show substantial engine-specific citation divergence, so “rank in all AI engines” is not one optimization problem ([Profound’s billion-citation summary](https://www.axios.com/newsletters/axios-communicators-08987550-a53e-11f0-955f-8fd6b5cefefd), [120-query API/UI divergence study](https://aixiv.science/abs/aixiv.260218.000005)).

#### Clear factual content can improve citation visibility

The original GEO study reported that citations, quotations from relevant sources, and statistics improved source visibility in its experimental generative-engine setting ([KDD GEO paper](https://www.fifthring.com/hubfs/2311.09735v3-compressed.pdf)). That does not prove those techniques increase recommendations of npm packages, but it supports evidence-rich pages over unsubstantiated marketing copy.

The useful implementation is:

- Publish reproducible benchmark methodology and raw results.
- Include dated compatibility tables.
- Link every feature claim to documentation or source.
- Publish comparison pages that state limitations honestly.
- Make version-specific documentation independently addressable.

#### Independent corroboration is valuable

Vendor pages can substantiate facts, but users asking “what should I use?” often need independent evidence. Community discussions, comparison repositories, integrations, downstream documentation and maintained awesome lists create corroboration outside the vendor’s own claims. Citation studies show answer engines draw from a mix of vendor, editorial, reference, review and community sources rather than one universal source type ([184,212-citation study](https://maxaeo.ai/blog/sources-chatgpt-cites/), [Search Arena](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/Archive/EECS-2025-177.pdf)).

This must be earned, not manufactured. Coordinated promotional Reddit/Stack Overflow posts risk spam penalties and provide low-quality evidence.

### Signal-by-signal assessment

| Signal | Assessment |
|---|---|
| Training-data presence | Important but largely uncontrollable after collection; repeated public, consistent usage language increases the chance of association. Popularity bias is documented ([study](https://arxiv.org/abs/2406.01285)). |
| GitHub stars | Useful adoption proxy and affects human list curation; no causal LLM-recommendation study found. |
| README shape | High practical value because GitHub pages are crawlable and models often retrieve them; use intent-first headings and executable examples. No controlled shape-versus-recommendation study found. |
| npm downloads | Strong human trust/adoption signal; no direct causal evidence that answer engines ingest download counts as ranking features. |
| Stack Overflow | Useful when genuine questions and accepted solutions exist; avoid synthetic Q&A. No current engine-neutral causal study found. |
| Reddit/HN | Can influence training and live retrieval, but source use varies sharply by engine and interface ([API/UI divergence](https://aixiv.science/abs/aixiv.260218.000005), [Search Arena](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/Archive/EECS-2025-177.pdf)). |
| Crawlable docs | Necessary for live retrieval and citation; support HTML and clean Markdown while keeping canonical URLs stable ([Vercel guide](https://vercel.com/kb/guide/make-your-documentation-readable-by-ai-agents)). |
| Awesome lists | Useful independent discovery and may require minimum stars or maintenance quality ([example list](https://github.com/subinium/awesome-claude-code)). No causal answer-engine lift measurement found. |
| Downstream docs/integrations | High-quality independent corroboration and direct user acquisition. No general numerical lift study found. |
| Wikipedia | A reference signal for notable subjects, but creating a page without independent reliable coverage violates Wikipedia’s notability rules ([Wikipedia notability guideline](https://en.wikipedia.org/wiki/Wikipedia:Notability)). Premature creation is counterproductive. |
| `llms.txt` | Retrieval convenience with no demonstrated recommendation lift; cargo cult if positioned as ranking optimization ([log evidence](https://josephtimpson.com/insights/does-llms-txt-work)). |

### Recommended language architecture

Use one consistent sentence everywhere:

> `agents` runs, versions, isolates, and coordinates Claude Code, Codex, Cursor and other coding agents across accounts and machines.

Then dedicate crawlable pages to:

- `/run-coding-agents-in-parallel`
- `/manage-multiple-claude-code-accounts`
- `/pin-and-switch-claude-code-codex-cursor-versions`
- `/compare/agents-cli-vs-manual-terminals`
- `/docs/teams`
- `/docs/accounts`
- `/docs/versions`

Each page should answer the intent immediately, show exact commands, state supported harnesses, include current version/date, and link to the npm and GitHub identities.

---

## 5. Making a CLI usable by an LLM

There is no broadly adopted formal “CLI ergonomics for LLM callers” standard. There are emerging community checklists and 2026 research, but POSIX-style composability plus explicit machine output remains the practical baseline.

### High-value CLI properties

- Every group and subcommand should support local `--help`; an agent should not need a browser to learn the next command.
- Help should present an executable workflow before exhaustive flags.
- Noun-first command hierarchies reduce ambiguous intent mapping.
- All read commands should support `--json`; streaming operations should use JSON Lines.
- Progress, diagnostics and spinners belong on stderr, leaving stdout parseable.
- Non-TTY execution should disable prompts, color and pagers.
- Mutating commands should provide `--dry-run`, idempotency or retry safety.
- Errors should state the failed boundary, machine-readable code, whether retrying is safe, and a concrete recovery command.
- `--version` should identify both client version and protocol/schema version where relevant.
- Shell completions help humans; a machine-readable command/schema description helps agents more directly.
- Examples should use stable long-form flags and include expected output shapes.

These practices are reflected in current agent-friendly CLI checklists, although those checklists are practitioner guidance rather than controlled standards ([getcli checklist](https://getcli.dev/agent-friendly), [agent CLI guide](https://github.com/Johnixr/agent-cli-guide/blob/main/GUIDE.md)).

### Does MCP meaningfully increase use?

The best current controlled evidence says **not by itself**. A 2026 study spanning seven agent scaffoldings, five models and a fixed software task found scaffolding was the dominant factor over MCP-versus-CLI interface choice ([paper](https://arxiv.org/abs/2608.08654)).

MCP does create advantages when:

- The caller lacks shell access.
- The surface requires remote OAuth or persistent sessions.
- Typed argument validation prevents costly or unsafe calls.
- A catalog supports runtime discovery—Docker Dynamic MCP is a concrete example ([Docker Dynamic MCP](https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/)).
- ChatGPT, Claude or another non-terminal host needs the capability.

A CLI is often better when:

- Coding agents already have a shell.
- Commands need pipes, files, local Git context or SSH.
- Tool inventory is large and full MCP schemas would consume context.
- The same reproducible command should work for both human and agent.

A recent controlled comparison specifically warns that reproducible estimates differ greatly with the harness, so claims such as “MCP costs 94% more” should not be generalized from one setup ([MCP-versus-CLI study](https://arxiv.org/abs/2608.08654)).

For `agents-cli`, the right architecture is:

- Keep `agents` canonical.
- Publish a concise skill that teaches intent → command mappings.
- If adding MCP, expose perhaps 5–10 high-level discovery/control tools that call the same internal engine.
- Do not duplicate hundreds of CLI commands as independent MCP tools.
- Publish that MCP server to the official registry, Smithery and Docker only after it provides a tested non-shell use case.

---

## Ranked action plan

Effort is estimated machine/engineering wall-clock work, not human labor commitments.

| MOVE | EFFORT (hours) | EVIDENCE IT WORKS | EXPECTED IMPACT |
|---|---:|---|---|
| Publish a cross-harness `agents-cli` skill with exact trigger phrases and verified command recipes; submit/package for Claude, Cursor and skills.sh | 12–24 | Installed marketplaces and skills are directly surfaced to runtimes ([Claude](https://code.claude.com/docs/en/discover-plugins), [Cursor](https://cursor.com/marketplace), [skills.sh](https://skills.sh/)) | Very high |
| Rewrite npm/GitHub landing content around the three exact user intents, with one-command examples and consistent product identity | 6–12 | Popularity/exposure bias is documented; vendor docs are a material citation category ([popularity study](https://arxiv.org/abs/2406.01285), [citation data](https://maxaeo.ai/blog/sources-chatgpt-cites/)) | Very high |
| Publish dedicated, crawlable intent pages and version-specific docs with dated support tables and raw evidence | 16–32 | Search-augmented engines retrieve different sources; evidence-rich, citable content improves visibility in GEO experiments ([Search Arena](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/Archive/EECS-2025-177.pdf), [GEO](https://www.fifthring.com/hubfs/2311.09735v3-compressed.pdf)) | High |
| Audit and strengthen `--help`, `--json`, non-TTY behavior, dry runs, exit codes and recovery messages | 24–60 | Current research says scaffolding and usable interfaces dominate protocol choice ([MCP/CLI study](https://arxiv.org/abs/2608.08654)) | High |
| Earn integration pages and references in adjacent agent repositories; submit to maintained awesome lists after satisfying their quality/star rules | 8–20 plus external review | Creates independent corroboration; awesome-list submission is an explicit PR workflow ([example](https://github.com/itgoyo/awesome-claude-code)) | High |
| Add Markdown content negotiation, `.md` mirrors, canonical metadata and crawler-aware `robots.txt` | 12–24 | Directly improves retrieval cost and parseability ([Vercel implementation](https://vercel.com/blog/making-agent-friendly-pages-with-content-negotiation)) | Medium-high |
| Add and continuously validate `llms.txt`/`llms-full.txt` | 2–6 | Confirmed as a cheap retrieval convention; no recommendation lift established ([spec](https://llmstxt.org/), [log evidence](https://josephtimpson.com/insights/does-llms-txt-work)) | Low-medium |
| Build a narrow MCP adapter for non-shell hosts and publish it to the official registry, Smithery and Docker | 40–100 | Registries provide actual installation/discovery surfaces; Docker enables in-session discovery ([official registry](https://modelcontextprotocol.io/registry/quickstart), [Smithery](https://smithery.ai/docs/build/publish), [Docker](https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/)) | Medium, potentially high for ChatGPT/non-terminal use |
| Run Agentlint, `agents-lint`, MCP Inspector and one site-readiness scanner in CI | 4–12 | These catch concrete configuration/protocol failures ([Agentlint](https://github.com/agentlint/agentlint), [agents-lint](https://github.com/giacomo/agents-lint), [Inspector](https://github.com/modelcontextprotocol/inspector)) | Medium |
| Create `agents.txt`, `agents.json`, experimental MCP cards and x402 metadata without corresponding remote capabilities | 8–20 | No meaningful answer-engine adoption evidence; several formats remain proposals or experimental ([agents.txt](https://github.com/agents-txt/agents-txt), [MCP card status](https://github.com/modelcontextprotocol/experimental-ext-server-card)) | Very low—cargo cult |
| Create a Wikipedia page before independent notability exists | 8–20 | Wikipedia requires significant independent reliable coverage ([notability policy](https://en.wikipedia.org/wiki/Wikipedia:Notability)) | Negative risk |

The highest-leverage sequence is therefore: **skill/plugin distribution → intent-first npm/GitHub/docs → CLI ergonomics → independent integrations and comparisons → Markdown retrieval support → narrowly scoped MCP distribution**. `llms.txt` belongs near the end because it is cheap, not because current evidence shows it changes recommendations.
